
const shallowClone = require('xtend')
const validateModels = require('@tradle/validate-model')
const keepModelsFresh = require('@tradle/bot-require-models')
const mergeModels = require('@tradle/merge-models')
const baseModels = require('./base-models')
const createPrivateModels = require('./private-models')
const productsStrategy = require('./strategy')
const Gen = require('./gen')

const TESTING = process.env.NODE_ENV === 'test'

module.exports = function creator (opts={}) {
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
    throw new Error('namespace "tradle" is reserved. Your models will be ignored by the application')
  }

  const bizModels = Gen.applicationModels({
    models: shallowClone(baseModels, models),
    products,
    namespace
  })

  if (!Object.keys(bizModels.products).length) {
    throw new Error('no product models found')
  }

  const customModels = shallowClone(models, bizModels.additional)
  const privateModels = createPrivateModels(namespace)
  const allModels = mergeModels()
    .add(baseModels)
    .add(bizModels.all)
    .add(privateModels.all)
    .get()

  validateModels(allModels)

  const modelsGroups = {
    biz: bizModels,
    private: privateModels,
    all: allModels,
  }

  return {
    install,
    models: modelsGroups
  }

  function install (bot) {
    let uninstallKeepFresh
    const customModelsArr = values(customModels)
    if (!TESTING && customModelsArr.length) {
      uninstallKeepFresh = bot.use(keepModelsFresh(customModelsArr))
    }

    const publicAPI = bot.use(productsStrategy({
      models: modelsGroups
    }))

    publicAPI.uninstall = uninstall
    return publicAPI

    function uninstall () {
      if (uninstallKeepFresh) uninstallKeepFresh()

      publicAPI.uninstall()
    }
  }
}

function values (obj) {
  return Object.keys(obj).map(key => obj[key])
}
