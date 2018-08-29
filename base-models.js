const mergeModels = require('@tradle/merge-models')
const base = require('@tradle/models').models
const custom = require('@tradle/custom-models').models
const productsBot = require('@tradle/models-products-bot')

module.exports = mergeModels()
  .add(base, { validate: false })
  .add(custom, { validate: false })
  .add(productsBot, { validate: false })
  .get()
