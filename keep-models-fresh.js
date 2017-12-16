const crypto = require('crypto')
const co = require('co').wrap
const buildResource = require('@tradle/build-resource')
const baseModels = require('./base-models')
const { isPromise, stableStringify, shallowClone } = require('./utils')
const defaultPropertyName = 'modelsHash'

function defaultGetIdentifier (req) {
  return req.user.id
}

function hashObject (obj) {
  return hashString('sha256', stableStringify(obj))
}

function hashString (algorithm, data) {
  return crypto.createHash(algorithm).update(data).digest('hex')
}

function modelsToArray (models) {
  return Object.keys(models)
    .sort(compareAlphabetical)
    .map(id => models[id])
}

function compareAlphabetical (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

module.exports = function keepModelsFresh ({
  getModelsForUser,
  propertyName=defaultPropertyName,
  // unique identifier for counterparty
  // which will be used to track freshness.
  // defaults to user.id
  getIdentifier=defaultGetIdentifier,
  send
}) {
  // modelsObject => modelsArray
  // modelsArray => modelsHash
  const objToArray = new Map()
  const arrToHash = new Map()
  return co(function* (req) {
    const identifier = getIdentifier(req)
    const { user } = req
    if (!user[propertyName] || typeof user[propertyName] !== 'object') {
      user[propertyName] = {}
    }

    const modelsHash = user[propertyName][identifier]
    let models = getModelsForUser(user)
    if (isPromise(models)) {
      models = yield models
    }

    let modelsArray
    if (Array.isArray(models)) {
      modelsArray = models
    } else {
      modelsArray = objToArray.get(models)
      if (!modelsArray) {
        modelsArray = modelsToArray(models)
        objToArray.set(models, modelsArray)
      }
    }

    let hash = arrToHash.get(modelsArray)
    if (!hash) {
      hash = hashObject(modelsArray)
      arrToHash.set(modelsArray, hash)
    }

    if (hash === modelsHash) return

    user[propertyName][identifier] = hash
    const pack = buildResource({
      models: baseModels,
      model: 'tradle.ModelsPack',
      resource: {
        models: modelsArray
      }
    })
    .toJSON()

    const split = splitPack(pack)
    yield split.map(subPack => send({ req, object: subPack }))
  })
}

function splitPack (pack) {
  const { models } = pack
  let batch = []
  let batchLength = 0
  const batches = [batch]
  for (const model of models) {
    // keep under 128KB
    // leave some breathing room
    // as this might be wrapped in another message
    if (batchLength > 100000) {
      batch = []
      batchLength = 0
      batches.push(batch)
    }

    batch.push(model)
    batchLength += byteLength(model)
  }

  return batches.map(batch => {
    return shallowClone(pack, {
      models: batch
    })
  })
}

function toModelsMap (models) {
  if (!Array.isArray(models)) return models

  const obj = {}
  for (const model of models) {
    obj[model.id] = model
  }

  return obj
}

function byteLength (obj) {
  return Buffer.byteLength(JSON.stringify(obj))
}
