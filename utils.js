const crypto = require('crypto')
const debug = require('debug')(require('./package.json').name)
const co = require('co').wrap
const bindAll = require('bindall')
const _ = require('lodash')
const stableStringify = require('json-stable-stringify')
const allSettled = require('settle-promise').settle
const { TYPE } = require('@tradle/constants')
const validateResource = require('@tradle/validate-resource')
const buildResource = require('@tradle/build-resource')
const stateModels = require('./state-models')
const baseModels = require('./base-models')
const { getPropertyTitle, parseId, parseStub, getRef } = validateResource.utils
const {
  VERIFICATION,
  VERIFIED_ITEM,
  APPLICATION,
  MODELS_PACK
} = require('./types')

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
  let i = 0
  const results = []
  for (const arg of arr) {
    let ret = fn(arg, i++)
    if (isPromise(ret)) {
      ret = yield ret
    }

    results.push(ret)
  }

  return results
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

function getApplicationPermalinks ({ user }) {
  const model = stateModels.customer
  return Object.keys(model.properties)
    .reduce((applications, propertyName) => {
      let val = user[propertyName]
      if (!val) return applications

      // coerce to array
      val = [].concat(val)

      const property = model.properties[propertyName]
      const ref = getRef(property)
      if (ref === APPLICATION) {
        return applications.concat(val.map(getPermalinkFromResourceOrStub))
      }

      if (ref === stateModels.applicationStub.id) {
        return applications.concat(val.map(({ statePermalink }) => statePermalink))
      }

      return applications
    }, [])
}

function getVerificationPermalinks ({ user }) {
  const model = stateModels.customer
  return Object.keys(model.properties)
    .reduce((verifications, propertyName) => {
      let val = user[propertyName]
      if (!val) return verifications

      // coerce to array
      val = [].concat(val)

      const ref = getRef(model.properties[propertyName])
      if (ref === VERIFIED_ITEM) {
        return verifications.concat(val.map(({ permalink }) => permalink))
      }

      if (ref === VERIFICATION) {
        return verifications.concat(val.map(getPermalinkFromResourceOrStub))
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
  default:
    return null
  }
}

function normalizeNameProps (props) {
  return {
    firstName: props.firstName || props.givenName,
    lastName: props.lastName || props.surname
  }
}

function sha256 (data) {
  return hashObject(data, 'sha256')
}

function hashObject (obj, algorithm) {
  const data = typeof obj === 'string' || Buffer.isBuffer(obj)
    ? obj
    : stableStringify(obj)

  return calcHash(data, algorithm)
}

function calcHash (data, algorithm) {
  return crypto.createHash(algorithm).update(data).digest('hex')
}

function createNewVersionOfApplication ({ bot, state, application }) {
  application = buildResource.version(application)
  this.state.updateApplication({
    application,
    properties: { dateModified: Date.now() }
  })

  return this.bot.sign(application)
}

const getModelsPacks = co(function* ({ db, from, to }) {
  const between = this.bot.db.find({
    filter: {
      EQ: {
        [TYPE]: MODELS_PACK
      },
      BETWEEN: {
        _time: [from, to]
      }
    }
  })

  const before = this.bot.db.findOne({
    filter: {
      EQ: {
        [TYPE]: MODELS_PACK
      },
      LT: {
        _time: from
      }
    }
  })
  .catch(err => {
    if (err.name !== 'NotFound') throw err
  })

  const all = yield Promise.all([before, between])
  return flatten(all)
})

function getPermalinkFromResourceOrStub (object) {
  if (buildResource.isProbablyResourceStub(object)) {
    return parseStub(object).permalink
  }

  return buildResource.permalink(object)
}

function getLinkFromResourceOrStub (object) {
  if (buildResource.isProbablyResourceStub(object)) {
    return parseStub(object).link
  }

  return buildResource.link(object)
}

const flatten = arr => arr.reduce((flat, more) => flat.concat(more), [])

function categorizeApplicationModels ({ models, products }) {
  const productModels = products.map(id => models[id])
  const certificates = {}
  const certificateFor = {}
  const productForCertificate = {}

  productModels.forEach(productModel => {
    const { id } = productModel
    const certId = getCertificateModelId({ productModel })
    const cert = models[certId]
    if (!cert) return

    certificates[certId] = cert
    productForCertificate[certId] = productModel
    certificateFor[id] = cert
  })

  const all = {}
  const applicationModels = {
    products,
    certificates,
    certificateFor,
    productForCertificate,
    all
  }

  _.values(models)
    .concat(productModels)
    .forEach(model => all[model.id] = model)

  return applicationModels
}

function getCertificateModelId ({ productModel }) {
  const id = productModel.id || productModel
  const lastIdx = id.lastIndexOf('.')
  return `${id.slice(0, lastIdx)}.My${id.slice(lastIdx + 1)}`
}

function allSettledSuccesses (promises) {
  return allSettled(promises)
    .then(results => results
      .filter(r => r.isFulfilled)
      .map(r => r.value))
}

module.exports = {
  co,
  isPromise,
  series,
  allSettled,
  allSettledSuccesses,
  format,
  splitCamelCase,
  parseId,
  parseStub,
  wait,
  bindAll,
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
  hashObject,
  sha256,
  createNewVersionOfApplication,
  getModelsPacks,
  getLinkFromResourceOrStub,
  getPermalinkFromResourceOrStub,
  categorizeApplicationModels,
  getCertificateModelId,
}
