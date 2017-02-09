
# @tradle/bot-products

Sell your users some products. They have waaaaaay too much money

This is a strategy creator, meaning you can give you a set of models and it will create a products strategy around them. In the example below, a bot is created that offers the user a choice of several age-verification related products, the models for which can be found in ['./test/fixtures/agemodels.js'](./test/fixtures/agemodels.js)

## Usage 

To get this bot to sell your products, 

```js
// example.js
const sellProducts = require('./')
// ./test/fixtures/agemodels.js
// has several custom product and form models
const ageModels = require('./test/fixtures/agemodels')
module.exports = function ageVerification (bot) {
  const config = {
    // a unique namespace for your models
    namespace: 'age.police',
    models: ageModels
  }

  return sellProducts(bot, config)
}
```
