
const createProductsStrategy = require('./')
const ageModels = require('./test/fixtures/agemodels')
const ageVerificationStrategy = createProductsStrategy({
  namespace: 'only.people.old',
  models: ageModels,
  products: getProductModelIds(ageModels)
})

function getProductModelIds (models) {
  return Object.keys(models)
    .filter(id => models[id].subClassOf === 'tradle.FinancialProduct')
}

module.exports = ageVerificationStrategy
