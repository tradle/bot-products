
const createProductsStrategy = require('./')
const ageModels = require('./test/fixtures/models')
module.exports = function ageVerification (bot) {
  return createProductsStrategy(bot, {
    namespace: 'only.people.old',
    models: ageModels
  })
}
