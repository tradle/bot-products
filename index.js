
const shallowClone = require('xtend')
const baseModels = toModelsMap(require('@tradle/models/models'))
const validateModels = require('@tradle/validate-model')
const keepModelsFresh = require('@tradle/bot-require-models')
const productsStrategy = require('./strategy')
const {
  genApplicationModels
} = require('./utils')

module.exports = function createProductsStrategy (opts={}) {
  const {
    // defaults
    namespace,
    models,
    products
  } = opts

  if (!namespace) {
    throw new Error('expected unique string "namespace"')
  }

  if (namespace === 'tradle') {
    throw new Error('namespace "io.tradle" is reserved. Your models will be ignored by the application')
  }

  const appModels = genApplicationModels({ models, products, namespace })
  if (!Object.keys(appModels.products).length) {
    throw new Error('no product models found')
  }

  const customModels = shallowClone(models, appModels.additional)
  const modelById = shallowClone(baseModels, customModels)
  validateModels(values(modelById))

  return function install (bot) {
    const uninstall1 = bot.use(keepModelsFresh(customModels))
    const uninstall2 = bot.use(productsStrategy, {
      modelById,
      appModels
    })

    return function () {
      uninstall1()
      uninstall2()
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
