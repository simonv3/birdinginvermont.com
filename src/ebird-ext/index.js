const Town_boundaries = require('./vt_towns.json')
const Vermont_regions = require('./Polygon_VT_Biophysical_Regions.json')
const VermontRecords = require('./vermont_records.json')
const CountyBarcharts = require('./countyBarcharts.json')
const VermontSubspecies = require('./vermont_records_subspecies.json')
const GeoJsonGeometriesLookup = require('geojson-geometries-lookup')
const vermontTowns = new GeoJsonGeometriesLookup(Town_boundaries)
const vermontRegions = new GeoJsonGeometriesLookup(Vermont_regions)
const fs = require('fs').promises
const _ = require('lodash')
const Papa = require('papaparse')
const moment = require('moment')
const difference = require('compare-latlong')
const appearsDuringExpectedDates = require('./appearsDuringExpectedDates.js')
const provinces = require('provinces')

function removeSpuh (arr) {
  const newArr = []
  for (var i in arr) {
    if (arr[i]['Scientific Name'] &&
      !arr[i]['Scientific Name'].includes('sp.') &&
      !arr[i]['Scientific Name'].includes(' x ') && // Get rid of hybrids
      !arr[i]['Scientific Name'].includes('Domestic type') && // Get rid of Domestic types
      !arr[i]['Scientific Name'].split(' ').slice(0, 2).join(' ').includes('/') // No Genus-level splits
      // !arr[i]['Scientific Name'].includes('[') &&
      // !arr[i]['Scientific Name'].match(/.* .* .*/g) &&
      // !arr[i]['Scientific Name'].includes('/')
    ) {
      // Remove subspecies only entries
      // For some reason, simply copying over the field before redefining it doesn't work.
      // Probably due to JavaScript reference errors.
      const specie = arr[i]
      if (specie['Scientific Name'].split(' ').slice(2).length !== 0) {
        arr[i]['Subspecies'] = _.clone(arr[i]['Scientific Name'])
      }
      specie['Scientific Name'] = specie['Scientific Name'].split(' ').slice(0, 2).join(' ')
      newArr.push(specie)
      // } else {
      // Use this to find excluded entries
      // console.log(arr[i]['Scientific Name'])
    }
  }
  return _.uniq(newArr)
}


async function vt251(input) {
  const opts = {
    year: 2021,
    state: 'Vermont',
    all: true,
    complete: true,
    input
  }
  const data = await towns(opts)
  return data
}

function removeSpuhFromCounties (countyBarcharts) {
  const newObj = {}
  Object.keys(CountyBarcharts).forEach(county => {
    newObj[county] = removeSpuh(Object.keys(CountyBarcharts[county].species).map(s => {
      const species = CountyBarcharts[county].species[s]
      // ES6 probably has a better way of doing this.
      species.name = s
      return species
    })).map(s => s.name)
  })
  return newObj
}

// Useful for when Rock Pigeon is being compared against other lists, or for times when a single sighting contains only subspecies
function cleanCommonName (arr) {
  return arr.map(s => s.split('(')[0].trim())
}

async function getData (input) {
  if (fs) {
    input = await fs.readFile(input, 'utf8')
    input = Papa.parse(input, { header: true })
    return removeSpuh(input.data)
  }

  return removeSpuh(input)
}

function parseDateformat (timespan) {
  let dateFormat
  if (timespan === 'year') {
    dateFormat = 'YYYY'
  } else if (timespan === 'month') {
    dateFormat = 'YYYY-MM'
  } else if (timespan === 'day') {
    dateFormat = 'YYYY-MM-DD'
  } else if (timespan) {
    throw new Error('Unable to parse timespan. Must be: year, month, or day.')
  }
  return dateFormat
}

function momentFormat (dateStr) {
  if (dateStr.includes('-')) {
    return 'YYYY-MM-DD'
  } else if (dateStr.includes('/')) {
    return 'MM/DD/YYYY'
  } else {
    throw new Error('Invalid Date String')
  }
}

function createPeriodArray (data) {
  const periodArray = []
  for (const period in data) {
    periodArray.push({
      Date: period,
      SpeciesTotal: removeSpuh(_.uniqBy(data[period], 'Scientific Name')).length,
      Species: removeSpuh(_.uniqBy(data[period], 'Scientific Name'))
    })
  }
  return _.sortBy(periodArray, 'SpeciesTotal').reverse()
}

function capitalizeFirstLetters(string) {
  return string.toLowerCase().split(' ').map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ')
}

function locationFilter (list, opts) {
  const filterList = ['Country', 'State', 'Region', 'County', 'Town']
  const intersection = _.intersection(Object.keys(opts).map(x => capitalizeFirstLetters(x)), filterList)

  return list.filter(checklist => {
    if (!checklist.Latitude) {
      // Some audio records appear to be totally empty locationalls
      if (opts.verbose) {
        console.log(`Checklist discarded: ${checklist['eBird Checklist URL']}.`)
      }
      return false
    }
    if (!checklist.State) {
      let [country, state] = checklist['State/Province'].split('-')
      if (state === 'VT') { // Just to speed things up a bit
        checklist.State = 'Vermont'
      } else if (['US', 'CA'].includes(country)) { // Enable for others
        if (_.findIndex(provinces, {short: state}) !== -1) { // Note that this file is larger than needed, and has more countries
          checklist.State = provinces[_.findIndex(provinces, {short: state})].name
        }
      }
      checklist.Country = country
    }
    if (checklist.State === 'Vermont') {
      // This option takes 25 seconds to do, every time, on my data
      // Might be worth just not including.
      let point = pointLookup(Vermont_regions, vermontRegions, checklist)
      checklist.Region = point

      // This one takes 3.5 seconds
      checklist.Town = pointLookup(Town_boundaries, vermontTowns, checklist)
    }

    return intersection.every(filter => checklist[filter] === opts[filter.toLowerCase()])
  })
}

function dateFilter (list, opts) {
  // TODO Make month and day work
  if (!opts.year) {
    return list
  }
  return list.filter(x => {
    return moment(x.Date, momentFormat(x.Date)).format('YYYY') === opts.year.toString()
  })
}

function completeChecklistFilter (list, opts) {
  const completeProtocols = ['eBird - Traveling Count', 'eBird - Stationary Count']
  if (opts.complete) {
    return list.filter(x => {
      return completeProtocols.includes(x.Protocol)
    })
  } else {
    return list
  }
}

function orderByDate (arr) {
  return _.orderBy(arr, (e) => moment(e.Date, momentFormat(e.Date)).format())
}

async function biggestTime (timespan, opts) {
  const dateFormat = parseDateformat(timespan)
  const data = await getData(opts.input)
  const dataByDate = {}

  // Sort by the amount of unique entries per day
  data.forEach((e) => {
    const period = moment(e.Date, momentFormat(e.Date)).format(dateFormat)
    if (!dataByDate[period]) {
      dataByDate[period] = [e]
    } else {
      dataByDate[period].push(e)
    }
  })

  return createPeriodArray(dataByDate)[0]
}

async function firstTimes (timespan, opts) {
  const dateFormat = parseDateformat(timespan)
  const data = orderByDate(await getData(opts.input)) // Sort by the date, instead
  const dataByDate = {}
  const speciesIndex = {}

  // Sort by the amount of unique entries per day
  data.forEach((e) => {
    const period = moment(e.Date, momentFormat(e.Date)).format(dateFormat)
    if (!speciesIndex[e['Scientific Name']]) {
      if (!dataByDate[period]) {
        dataByDate[period] = [e]
      } else {
        dataByDate[period].push(e)
      }
      // TODO Use scientific name
      speciesIndex[e['Scientific Name']] = e.Date
    }
  })

  return createPeriodArray(dataByDate)[0]
}

async function firstTimeList (opts) {
  // TODO Fix
  // const dateFormat = parseDateformat('day')
  // const data = orderByDate(dateFilter(locationFilter(await getData(opts.input), opts), opts))
  // const dataByDate = {}
  // const speciesIndex = {}
  //
  // data = countUniqueSpecies(data)
  //
  // let i = 1
  // // TODO Doesn't work for MyEBirdData for some reason
  // _.sortBy(createPeriodArray(dataByDate), 'Date').forEach((e) => {
  //   e.Species.forEach((specie) => {
  //     console.log(`${i} | ${specie['Common Name']} - ${specie['Scientific Name']} | ${(specie.County) ? specie.County + ', ' : ''}${specie['State/Province']} | ${e.Date}`)
  //     i++
  //   })
  // })
}

// Sort by the amount of unique entries per day
function countUniqueSpecies (data, dateFormat) {
  const speciesIndex = {}
  const dataByDate = {}
  data.forEach((e) => {
    const period = moment(e.Date, momentFormat(e.Date)).format(dateFormat)
    const specie = e['Scientific Name']
    if (!speciesIndex[specie]) {
      if (!dataByDate[period]) {
        dataByDate[period] = [e]
      } else {
        dataByDate[period].push(e)
      }
      speciesIndex[specie] = e.Date
    }
  })

  return dataByDate
}

function getAllTowns (geojson) {
  const towns = []
  geojson.features.forEach((t) => {
    towns.push({
      town: t.properties.town
    })
  })
  return towns
}

/* node cli.js count -i=MyEBirdData.csv --town="Fayston" --state=Vermont
As this is set up, it will currently return only the first time I saw species in each town provided, in Vermont */
async function towns (opts) {
  if (!opts.state) {
    // We only have towns for this state
    opts.state = 'Vermont'
  }
  const dateFormat = parseDateformat('day')
  let data = orderByDate(completeChecklistFilter(dateFilter(locationFilter(await getData(opts.input), opts), opts), opts), opts)
  var speciesSeenInVermont = []
  _.forEach(countUniqueSpecies(data, dateFormat), (o) => {
    var mapped = _.map(o, 'Common Name')
    speciesSeenInVermont.push(mapped)
  })
  speciesSeenInVermont = _.flatten(speciesSeenInVermont)
  if (opts.all) {
    const towns = getAllTowns(Town_boundaries)
    towns.forEach(t => {
      let i = 0
      t.species = []
      t.speciesByDate = countUniqueSpecies(data.filter(x => x.Town === t.town), dateFormat)
      _.sortBy(createPeriodArray(t.speciesByDate), 'Date').forEach((e) => {
        e.Species.forEach((species) => {
          t.species.push(species['Common Name'])
          i++
        })
      })
      t.speciesTotal = i
    })

    return towns
    // fs.writeFile('vt_town_counts.json', JSON.stringify(towns), 'utf8')

  } else if (opts.town) {
    data = countUniqueSpecies(data.filter(x => x.Town === opts.town), dateFormat)

    let i = 1
    // TODO Doesn't work for MyEBirdData for some reason
    _.sortBy(createPeriodArray(data), 'Date').forEach((e) => {
      e.Species.forEach((specie) => {
        console.log(`${i} | ${specie['Common Name']} - ${specie['Scientific Name']} | ${opts.town}, ${(specie.County) ? specie.County + ', ' : ''}${specie['State']} | ${e.Date}`)
        i++
      })
    })
  }
}

/* node cli.js counties -i=MyEBirdData.csv
As this is set up, it will currently return only the first time I saw species in each town provided, in Vermont */
async function counties (opts) {
  opts.state = 'Vermont'
  const dateFormat = parseDateformat('day')
  let data = orderByDate(dateFilter(locationFilter(await getData(opts.input), opts), opts), opts)

  const countySpecies = removeSpuhFromCounties(CountyBarcharts)

  const counties = Object.keys(CountyBarcharts).map(county => {
    const speciesByDate = countUniqueSpecies(data.filter(x => x.County === county), dateFormat)
    const species = _.sortBy(createPeriodArray(speciesByDate), 'Date').map(period => {
        return period.Species.map(species => species['Common Name'])
      }).flat()
    return {
      county,
      collectiveTotal: countySpecies[county].length,
      species,
      speciesByDate,
      speciesTotal: species.length
    }
  })

  // Again, as above es6 probably has a better way of doing this.
  const newObj = {}
  counties.forEach(c => newObj[c.county] = c)

  function countyTicks () {
    let total = Object.keys(newObj).reduce((prev, cur) => {
      return prev + newObj[cur].speciesTotal;
    }, 0)
    console.log(`Total ticks: ${total}.`)
  }

  if (opts.ticks) {
    countyTicks()
  }

  if (opts.county) {
    console.log(newObj[opts.county])
    return newObj[opts.county]
  }

  return newObj
}

async function winterFinch (opts) {
  function sortedList(list, orderedList) {
    list = list.map(species => species.split(' (')[0])
    return list.sort((a, b) => orderedList.indexOf(a) - orderedList.indexOf(b))
  }

  const owls = [
    'Eastern Screech-owl',
    'Great Horned Owl',
    'Snowy Owl',
    'Barred Owl',
    'Long-eared Owl',
    'Short-eared Owl',
    'Boreal Owl',
    'Northern Saw-whet Owl'
  ]

  const winterFinches = [
    'Rough-legged Hawk',
    'Snowy Owl',
    'Northern Shrike',
    'Boreal Chickadee',
    'Horned Lark',
    'Bohemian Waxwing',
    'Evening Grosbeak',
    'Pine Grosbeak',
    'Common Redpoll',
    'Hoary Redpoll',
    'Red Crossbill',
    'White-winged Crossbill',
    'Pine Siskin',
    'Lapland Longspur',
    'Snow Bunting',
    'American Tree Sparrow'
  ]

  const data = await counties(opts)
  Object.keys(data).forEach(county => {
    const intersection = sortedList(_.intersection(cleanCommonName(data[county].species), winterFinches), winterFinches)
    console.log(`${county} (${intersection.length})${(intersection.length !== 0) ? `: ${intersection.join(', ')}.` : ''}`)
  })

  console.log('')
  Object.keys(data).forEach(county => {
    const intersection = sortedList(_.intersection(cleanCommonName(data[county].species), owls), owls)
    console.log(`${county} (${intersection.length})${(intersection.length !== 0) ? `: ${intersection.join(', ')}.` : ''}`)
  })
}

/* node cli.js count -i=MyEBirdData.csv --town="Fayston" --state=Vermont
As this is set up, it will currently return only the first time I saw species in each town provided, in Vermont */
async function regions (opts) {
  opts.state = 'Vermont'
  const dateFormat = parseDateformat('day')
  let data = orderByDate(dateFilter(locationFilter(await getData(opts.input), opts), opts), opts)

  function getRegions (geojson) {
    const regions = []
    geojson.features.forEach((r) => regions.push({ region: r.properties.name }))
    return regions
  }

  const regions = getRegions(Vermont_regions)
  regions.forEach(r => {
    let i = 0
    r.species = []
    r.speciesByDate = countUniqueSpecies(data.filter(x => x.Region === r.region), dateFormat)
    _.sortBy(createPeriodArray(r.speciesByDate), 'Date').forEach((e) => {
      e.Species.forEach((specie) => {
        r.species.push(specie['Common Name'])
        i++
      })
    })
    r.speciesTotal = i
    // console.log(`Region: ${r.region}. Species count: ${r.speciesTotal}.`)
  })

  return regions
  // fs.writeFile('vt_region_counts.json', JSON.stringify(regions), 'utf8')
}

async function radialSearch (opts) {
  const dateFormat = parseDateformat('day')
  let radius = opts.distance || 10 // miles
  let lat = opts.coordinates[0]
  let long = opts.coordinates[1]
  console.log(dateFormat, lat, long)
  let data = await getData(opts.input)

  // Get a total list of species that you have seen in Vermont
  // TODO Get a list of all species ever seen in Vermont, here.
  var speciesSeenInVermont = []
  opts.state = 'Vermont'
  _.forEach(countUniqueSpecies(dateFilter(locationFilter(data, opts), opts), dateFormat), (o) => {
    var mapped = _.map(o, 'Common Name')
    speciesSeenInVermont.push(mapped)
  })
  speciesSeenInVermont = _.flatten(speciesSeenInVermont)

  data = orderByDate(data, opts).filter((d) => {
    let distance = difference.distance(lat, long, d.Latitude, d.Longitude, 'M')
    return distance <= radius
  })
  let i = 0
  let areaResults = {}

  areaResults.species = []
  areaResults.speciesByDate = countUniqueSpecies(data, dateFormat)
  _.sortBy(createPeriodArray(areaResults.speciesByDate), 'Date').forEach((e) => {
    e.Species.forEach((specie) => {
      areaResults.species.push(specie['Common Name'])
      i++
    })
  })
  areaResults.speciesTotal = i

  return areaResults
}

async function quadBirds (opts) {
  const files = opts.input.split(',')
  let data = []
  await Promise.all(files.map(async (file) => {
    const contents = await getData(file)
    data = data.concat(contents)
  }))
  data = orderByDate(dateFilter(locationFilter(data, opts), opts))
  const speciesIndex = {}
  let completionDates = []

  // Sort by the amount of unique entries per day
  data.forEach((e) => {
    const species = e['Scientific Name']
    if (!speciesIndex[species]) {
      speciesIndex[species] = {
        seen: undefined,
        audio: undefined,
        photo: undefined,
        species: e
      }
    }
    if (e['Submission ID'] && !speciesIndex[species].seen) {
      speciesIndex[species].seen = moment(e.Date, momentFormat(e.Date)).format('YYYY-MM-DD')
    }
    if (e.Format === 'Photo' && !speciesIndex[species].photo) {
      speciesIndex[species].photo = moment(e.Date, momentFormat(e.Date)).format('YYYY-MM-DD')
    }
    if (e.Format === 'Audio' && !speciesIndex[species].audio) {
      speciesIndex[species].audio = moment(e.Date, momentFormat(e.Date)).format('YYYY-MM-DD')
    }
    if (!speciesIndex[species].completed &&
      speciesIndex[species].audio &&
      speciesIndex[species].photo &&
      speciesIndex[species].seen) {
      if (moment(speciesIndex[species].audio, momentFormat(speciesIndex[species].audio)).isBefore(speciesIndex[species].photo, momentFormat(speciesIndex[species].audio))) {
        speciesIndex[species].completed = speciesIndex[species].photo
      } else {
        speciesIndex[species].completed = speciesIndex[species].audio
      }
      completionDates.push({ Date: speciesIndex[species].completed, species: speciesIndex[species].species })
    }
  })

  completionDates = orderByDate(completionDates)

  if (opts.list) {
    for (const species in completionDates) {
      console.log(`${completionDates[species].Date}: ${completionDates[species].species['Common Name']}.`)
    }
  }
  console.log(`You ${(!opts.year || opts.year.toString() === moment().format('YYYY')) ? `have seen` : `saw`}, photographed, and recorded a total of ${completionDates.length} species${(opts.year) ? ` in ${opts.year}` : ''}.`)
}

function pointLookup(geojson, geojsonLookup, data) {
  let point = {type: "Point", coordinates: [data.Longitude, data.Latitude]}
  let containerArea = geojsonLookup.getContainers(point)
  if (containerArea.features[0]) {
    let props = containerArea.features[0].properties
    return (props.town) ? props.town : props.name
  }
  // If, for some reason, the point is on a border and the map I have discards it, but eBird doesn't - just discard it.
  // This can be fixed by using nearest neighbor approaches, but those tend to have a high computational load, and they require
  // mapping libraries that need window, which just stinks.
  return
}

async function rare (opts) {
  // if (!opts.year) {
  //   opts.year = moment().format('YYYY')
  // }
  let data
  opts.state = 'Vermont'
  // Use only data from this year, from Vermont
  if (!opts.manual) {
    data = dateFilter(locationFilter(await getData(opts.input), opts), opts)
  } else {
    // TODO: Enable rarities to check an input with a species' Common Name, Town, and Date
    // - Figure out how to get input from a dropdown in React
    //   - Discrete input (town out of all towns)
    //   - Date input
    // - Get latlong for a given town
    // - Get county for a given town
    // - Get region for a given town
    // - Get scientific name for a given bird

    // This will correctly flag as 'Unknown'
    data = [{
      'Species': 'Pine Marten',
      'Date': '2020-03-02',
      'Scientific Name': 'Martes martes',
      'Town': 'Montpelier',
      'Region': 'Northern Piedmont',
      'County': 'Washington'
    }]
  }
  const allSpecies = VermontRecords.map(x => x['Scientific Name'])
  const speciesToReport = VermontRecords.map(x => x['Scientific Name'])
  // TODO Update needs JSON file
  const output = {
    'Breeding': [],
    'Vermont': [],
    'Burlington': [],
    'Champlain': [],
    'NEK': [],
    'Unknown': [],
    'Subspecies': [],
    'OutsideExpectedDates': []
  }
  data.forEach(e => {
    let species = e['Scientific Name']
    if (speciesToReport.includes(species)) {
      let recordEntry = VermontRecords.find(x => x['Scientific Name'] === species)
      // TODO Document this. Could also check Observation Details or Checklist Comments
      if (!appearsDuringExpectedDates(e.Date, recordEntry.Occurrence)) {
        output.OutsideExpectedDates.push(e)
      } else if (recordEntry.Breeding !== '*' && e['Breeding Code']) {
        output.Breeding.push(e)
      } else if (recordEntry.Reporting === 'N' && (e['Breeding Code'])) {
        output.Breeding.push(e)
      } else if (recordEntry.Reporting === 'V') {
        // Anyhwere in Vermont
        output.Vermont.push(e)
      } else if (recordEntry.Reporting === 'B') {
        // Outside of Burlington
        const towns = ['Burlington', 'South Burlington', 'Essex', 'Colchester', 'Winooski', 'Shelburne']
        if (!towns.includes(e.Town)) {
          output.Burlington.push(e)
        }
      } else if (recordEntry.Reporting === 'C') {
        // Outside of Lake Champlain Basin
        if (e.Region !== 'Champlain Valley') {
          output.Champlain.push(e)
        }
      } else if (recordEntry.Reporting === 'K') {
        // Outside of the NEK
        const counties = ['Essex', 'Caledonia', 'Orleans']
        if (!counties.includes(e.County)) {
          output.NEK.push(e)
        }
      }
    } else if (!allSpecies.includes(species)) {
      output.Unknown.push(e)
    }

    if (e.Subspecies) {
      let species = VermontSubspecies.find(x => e['Scientific Name'] === x['Scientific Name'])
      if (species && species['Target Subspecies'].includes(e.Subspecies)) {
        e['Subspecies Notes'] = species
        output.Subspecies.push(e)
      } else if (species && !species['Vermont Subspecies'].includes(e.Subspecies)) {
        if (species['Target Subspecies'][0] === "") {
          e['Subspecies Notes'] = species
          output.Subspecies.push(e)
        } else {
          e['Subspecies Notes'] = species
          output.Subspecies.push(e)
        }
      }
    }
  })

  return output
}

// async function today (opts) {
  // I want to know:
  // - Was today a big day?
  // - Did I get new world birds today?
  // - Did I get new country birds today?
  // - Did I get new state birds today?
  // - Did I get new county birds today?
  // - Did I get new photo birds today?
  // - Did I get new audio birds today?
// }

// Switch this for CLI testing
// module.exports = {
export default {
  biggestTime,
  firstTimeList,
  firstTimes,
  quadBirds,
  radialSearch,
  rare,
  regions,
  removeSpuh,
  removeSpuhFromCounties,
  towns,
  counties,
  winterFinch,
  vt251
}
