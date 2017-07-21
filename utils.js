const debug = require('debug')('tradle:bot:products')
const co = require('co').wrap
const bindAll = require('bindall')
const shallowExtend = require('xtend/mutable')
const shallowClone = require('xtend')
const pick = require('object.pick')
const isPromise = obj => obj && typeof obj.then === 'function'
const STRINGS = require('./strings')

// function getNamespaceIds (namespace) {
//   return {
//     productList: getProductListModelId(namespace),
//     productApplication: getProductApplicationModelId(namespace)
//   }
// }


// source: http://stackoverflow.com/questions/610406/javascript-equivalent-to-printf-string-format
function format (str, ...args) {
  return str.replace(/{(\d+)}/g, function (match, number) {
    return typeof args[number] === 'undefined'
      ? match
      : args[number]
    ;
  })
}

function splitCamelCase (str) {
  return str.split(/(?=[A-Z])/g)
}

function parseId (id) {
  const [type, permalink, link] = id.split('_')
  return {
    type,
    permalink,
    link
  }
}

function wait (millis) {
  return new Promise(resolve => setTimeout(resolve, millis))
}

function getValues (obj) {
  return Object.keys(obj).map(id => obj[id])
}

module.exports = {
  co,
  isPromise,
  format,
  splitCamelCase,
  parseId,
  wait,
  pick,
  shallowExtend,
  shallowClone,
  bindAll,
  getValues,
  debug
}
