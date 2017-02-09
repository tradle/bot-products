
const createProductsStrategy = require('./')
const ageModels = require('./test/fixtures/agemodels')
module.exports = createProductsStrategy({
  namespace: 'only.people.old',
  models: ageModels
})
