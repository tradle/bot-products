
const createProductsStrategy = require('./')
const ageModels = require('./test/fixtures/agemodels')
const ageVerificationStrategy = createProductsStrategy({
  namespace: 'only.people.old',
  models: ageModels
})

module.exports = ageVerificationStrategy
