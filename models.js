const mergeModels = require('@tradle/merge-models')
const Gen = require('./gen')
const baseModels = require('./base-models')
const createPrivateModels = require('./private-models')
const {
  shallowClone,
  uniq
} = require('./utils')

module.exports = ModelManager

function ModelManager ({ namespace }) {
  this.namespace = namespace
  this.private = createPrivateModels(namespace)
  this.all = mergeModels()
    .add(baseModels)
    .add(this.private.all)
    .get()

  this.products = []
}

ModelManager.prototype.addProducts = function ({ models, products }) {
  const newAllModels = shallowClone(this.all, models ? models.all : {})
  products.forEach(id => {
    const model = newAllModels[id]
    if (!model) {
      throw new Error(`missing model for product ${id}`)
    }

    if (model.subClassOf !== 'tradle.FinancialProduct') {
      throw new Error(`${id} is not a product!`)
    }
  })

  this.biz = Gen.applicationModels({
    models: newAllModels,
    products: uniq(products.concat(this.products || [])),
    namespace: this.namespace
  })

  if (models) {
    ['private', 'biz'].forEach(subset => {
      if (!models[subset] || !models[subset].all) return

      if (!this[subset]) {
        this[subset] = {}
      }

      const all = shallowClone(
        this[subset].all,
        models[subset].all
      )

      this[subset] = shallowClone(this[subset], models[subset])
      this[subset].all = all
    })
  }

  this.all = mergeModels()
    .add(baseModels)
    .add(this.private.all)
    .add(this.biz.all)
    .get()
}
