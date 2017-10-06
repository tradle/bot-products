const debug = require('debug')(require('./package.json').name)
const co = require('co').wrap
const bindAll = require('bindall')
const shallowExtend = require('xtend/mutable')
const shallowClone = require('xtend')
const clone = require('clone')
const deepEqual = require('deep-equal')
const pick = require('object.pick')
const omit = require('object.omit')
const uniq = require('uniq')
const stableStringify = require('json-stable-stringify')
const validateResource = require('@tradle/validate-resource')
const buildResource = require('@tradle/build-resource')
const baseModels = require('./base-models')
const { getPropertyTitle } = validateResource.utils

function isPromise (obj) {
  return obj && typeof obj.then === 'function'
}

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

function wait (millis) {
  return new Promise(resolve => setTimeout(resolve, millis))
}

function getValues (obj) {
  return Object.keys(obj).map(id => obj[id])
}

function validateRequired ({ model, resource }) {
  const propertyName = (model.required || []).find(name => {
    return !(name in resource)
  })

  if (propertyName) {
    const title = getPropertyTitle({ model, propertyName })
    const message = `"${title}" is required`
    return {
      message,
      errors: [{
        name: propertyName,
        message
      }]
    }
  }

  return null
}

const series = co(function* (arr, fn) {
  for (const arg of arr) {
    const ret = fn(arg)
    if (isPromise(ret)) yield ret
  }
})

// function getProductFromEnumValue ({ bizModels, value }) {
//   if (value.id.indexOf(bizModels.productList.id) === 0) {
//     return value.id.slice(bizModels.productList.id.length + 1)
//   }

//   return value.id
// }

function ensureLinks (object) {
  if (!object._link) {
    const link = buildResource.calcLink(object)
    buildResource.setVirtual(object, {
      _link: link,
    })
  }

  if (!object._permalink) {
    buildResource.setVirtual(object, {
      _permalink: buildResource.permalink(object),
    })
  }

  return object
}

function createSimpleMessage (message) {
  return buildResource({
      models: baseModels,
      model: 'tradle.SimpleMessage',
      resource: { message }
    })
    .toJSON()
}

function getContext ({ model, resource }) {
  const interfaces = model.interfaces
  if (interfaces && interfaces.includes('tradle.Context')) {
    return resource.contextId
  }
}

function getRequestContext ({ req, models }) {
  if (req.message.context) {
    return req.message.context
  }

  return getContext({
    model: models[req.type],
    resource: req.payload
  })
}

module.exports = {
  co,
  isPromise,
  series,
  format,
  splitCamelCase,
  parseId: validateResource.utils.parseId,
  wait,
  uniq,
  omit,
  pick,
  shallowExtend,
  shallowClone,
  clone,
  deepEqual,
  bindAll,
  getValues,
  debug,
  validateRequired,
  // getProductFromEnumValue,
  ensureLinks,
  stableStringify,
  createSimpleMessage,
  getContext,
  getRequestContext
}
