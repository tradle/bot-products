
const shallowClone = require('xtend')
const baseModels = toModelsMap(require('@tradle/models/models'))
const validateModels = require('@tradle/validate-model')
const keepModelsFresh = require('@tradle/bot-require-models')
const productsStrategy = require('./strategy')
const {
  genApplicationModels
} = require('./utils')

const TESTING = process.env.NODE_ENV === 'test'

module.exports = function creator (opts={}) {
  const {
    // defaults
    namespace,
    models,
    products,
    handlers={}
  } = opts

  if (!namespace) {
    throw new Error('expected unique string "namespace"')
  }

  if (namespace === 'tradle') {
    throw new Error('namespace "io.tradle" is reserved. Your models will be ignored by the application')
  }

  const appModels = genApplicationModels({
    models: shallowClone(baseModels, models),
    products,
    namespace
  })

  if (!Object.keys(appModels.products).length) {
    throw new Error('no product models found')
  }

  const customModels = shallowClone(models, appModels.additional)
  const modelById = shallowClone(baseModels, customModels)
  validateModels(values(modelById))

  return {
    install,
    models: appModels
  }

  function install (bot) {
    let uninstallKeepFresh
    const customModelsArr = values(customModels)
    if (!TESTING && customModelsArr.length) {
      uninstallKeepFresh = bot.use(keepModelsFresh(customModelsArr))
    }

    const api = bot.use(productsStrategy, {
      modelById,
      appModels,
      handlers
    })

    return shallowClone(api, { uninstall })

    function uninstall () {
      if (uninstallKeepFresh) uninstallKeepFresh()

      api.uninstall()
    }
  }
}

function values (obj) {
  return Object.keys(obj).map(key => obj[key])
}

function toModelsMap (arr) {
  if (!Array.isArray(arr)) return arr

  const obj = {}
  arr.forEach(item => obj[item.id] = item)
  return obj
}
