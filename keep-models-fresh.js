const crypto = require('crypto')
const co = require('co').wrap
const buildResource = require('@tradle/build-resource')
const baseModels = require('./base-models')
const { isPromise, stableStringify } = require('./utils')

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
  propertyName='modelsHash',
  send
}) {
  // modelsObject => modelsArray
  // modelsArray => modelsHash
  const objToArray = new Map()
  const arrToHash = new Map()
  return co(function* (req) {
    const { user } = req
    const modelsHash = user[propertyName]
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

    user.modelsHash = hash
    const pack = buildResource({
      models: baseModels,
      model: 'tradle.ModelsPack',
      resource: {
        models: modelsArray
      }
    })
    .toJSON()

    yield send({ req, object: pack })
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
