
# @tradle/bot-products

Sell your users some products. They have waaaaaay too much money

This is a strategy creator, meaning you can give you a set of models and it will create a products strategy around them. In the example below, a bot is created that offers the user a choice of several age-verification related products, the models for which can be found in ['./test/fixtures/agemodels.js'](./test/fixtures/agemodels.js)

## Usage 

To get this bot to sell your products, just ask nicely:

```js
// example.js
const createProductsStrategy = require('@tradle/bot-products')
// ./test/fixtures/agemodels.js
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
```
