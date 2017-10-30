const crypto = require('crypto')
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
const { TYPE } = require('@tradle/constants')
const validateResource = require('@tradle/validate-resource')
const buildResource = require('@tradle/build-resource')
const baseModels = require('./base-models')
const { getPropertyTitle, parseId, parseStub, getRef } = validateResource.utils
const VERIFICATION = 'tradle.Verification'
const APPLICATION = 'tradle.Application'

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
  const { interfaces } = model
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

function getApplicationPermalinks ({ user, models } ) {
  const model = models.private.customer
  return Object.keys(model.properties)
    .reduce((applications, propertyName) => {
      let val = user[propertyName]
      if (!val) return applications

      // coerce to array
      val = [].concat(val)

      const property = model.properties[propertyName]
      const ref = getRef(property)
      if (ref === APPLICATION) {
        return applications.concat(val.map(stub => parseStub(stub).permalink))
      }

      if (ref === models.private.applicationStub.id) {
        return applications.concat(val.map(({ statePermalink }) => statePermalink))
      }

      return applications
    }, [])
}

function getVerificationPermalinks ({ user, models }) {
  const model = models.private.customer
  return Object.keys(model.properties)
    .reduce((verifications, propertyName) => {
      let val = user[propertyName]
      if (!val) return verifications

      // coerce to array
      val = [].concat(val)

      const ref = getRef(model.properties[propertyName])
      if (ref === models.private.verifiedItem.id) {
        return verifications.concat(val.map(({ permalink }) => permalink))
      }

      if (ref === VERIFICATION) {
        return verifications.concat(val.map(stub => parseStub(stub).permalink))
      }

      return verifications
    }, [])
}

function getNameFromForm (form) {
  switch (form[TYPE]) {
  case 'tradle.SelfIntroduction':
  case 'tradle.Introduction':
  case 'tradle.IdentityPublishRequest':
    let { name, profile } = form
    if (!name && profile) {
      name = profile.name
    }

    let normalized = normalizeNameProps(name || profile)
    return normalized.firstName || normalized.lastName
      ? normalized
      : null
  case 'tradle.Name':
    return normalizeNameProps(form)
  }
}

function normalizeNameProps (props) {
  return {
    firstName: props.firstName || props.givenName,
    lastName: props.lastName || props.surname
  }
}

function sha256 (data) {
  return hashObject('sha256', data)
}

function hashObject (obj) {
  const data = typeof obj === 'string' || Buffer.isBuffer(obj)
    ? obj
    : stableStringify(obj)

  return calcHash('sha256', data)
}

function calcHash (algorithm, data) {
  return crypto.createHash(algorithm).update(data).digest('hex')
}

module.exports = {
  co,
  isPromise,
  series,
  format,
  splitCamelCase,
  parseId,
  parseStub,
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
  getRequestContext,
  getApplicationPermalinks,
  getVerificationPermalinks,
  getNameFromForm,
  hashObject
}
