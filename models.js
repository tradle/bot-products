const _ = require('lodash')
const mergeModels = require('@tradle/merge-models')
const baseModels = require('./base-models')
const { categorizeApplicationModels } = require('./utils')
const stateModels = require('./state-models')

module.exports = ModelManager

function ModelManager ({ validate }) {
  this.validate = validate
  this.all = mergeModels()
    .add(baseModels, { validate: false })
    .get()

  this.products = []
}

ModelManager.prototype.addProducts = function ({ models, products }) {
  const newAllModels = _.extend({}, this.all, models ? models.all : {})
  products.forEach(id => {
    const model = newAllModels[id]
    if (!model) {
      throw new Error(`missing model for product ${id}`)
    }

    if (model.subClassOf !== 'tradle.FinancialProduct') {
      throw new Error(`${id} is not a product!`)
    }
  })

  this.products = _.uniq(products.concat(this.products || []))
  this.biz = categorizeApplicationModels({
    models: newAllModels,
    products: this.products
  })

  if (models) {
    ['biz'].forEach(subset => {
      if (!models[subset] || !models[subset].all) return

      if (!this[subset]) {
        this[subset] = {}
      }

      const all = _.extend(
        {},
        this[subset].all,
        models[subset].all
      )

      this[subset] = _.extend({}, this[subset], models[subset])
      this[subset].all = all
    })
  }

  const opts = { validate: this.validate }
  this.all = mergeModels()
    .add(baseModels, opts)
    // .add(this.private.all, opts)
    .add(this.biz.all, opts)
    .get()
}
