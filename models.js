const mergeModels = require('@tradle/merge-models')
const Gen = require('./gen')
const baseModels = require('./base-models')
const createPrivateModels = require('./private-models')
const {
  shallowClone,
  uniq
} = require('./utils')

module.exports = ModelManager

function ModelManager ({ namespace, validate }) {
  this.namespace = namespace
  this.validate = validate
  this.private = createPrivateModels(namespace)
  this.all = mergeModels()
    .add(baseModels, { validate })
    .add(this.private.all, { validate })
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

  this.products = uniq(products.concat(this.products || []))
  this.biz = Gen.applicationModels({
    models: newAllModels,
    products: this.products,
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

  const opts = { validate: this.validate }
  this.all = mergeModels()
    .add(baseModels, opts)
    .add(this.private.all, opts)
    .add(this.biz.all, opts)
    .get()
}
