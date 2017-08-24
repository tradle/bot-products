const debug = require('debug')('tradle:bot:products')
const co = require('co').wrap
const bindAll = require('bindall')
const shallowExtend = require('xtend/mutable')
const shallowClone = require('xtend')
const pick = require('object.pick')
const validateResource = require('@tradle/validate-resource')
const { getPropertyTitle } = validateResource.utils
const isPromise = obj => obj && typeof obj.then === 'function'

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
}

function newFormState ({ type, object, link, permalink }) {
  const state = {
    type,
    form: {
      link,
      permalink,
      object
    }
  }

  return normalizeFormState(state)
}

function normalizeFormState (state) {
  // add "body" alias
  if (!state.form.body) {
    Object.defineProperty(state.form, 'body', {
      enumerable: false,
      get: () => state.form.object
    })
  }

  return state
}

function normalizeUserState (state) {
  ;['products', 'applications'].forEach(key => {
    const subState = state[key]
    if (subState) {
      for (let productType in subState) {
        subState[productType].forEach(appState => {
          appState.forms.forEach(normalizeFormState)
        })
      }
    }
  })
}

const series = co(function* (arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    let ret = fn(arr[i])
    if (isPromise(ret)) yield ret
  }
})

module.exports = {
  co,
  isPromise,
  series,
  format,
  splitCamelCase,
  parseId,
  wait,
  pick,
  shallowExtend,
  shallowClone,
  bindAll,
  getValues,
  debug,
  validateRequired,
  newFormState,
  normalizeUserState,
}
