
const test = require('tape')
const models = require('./fixtures/agemodels')
const {
  genEnumModel,
  // genMyProductModel,
  // getApplicationModels
} = require('../utils')

test('genModels', function (t) {
  const enumModel = genEnumModel({ models, id: 'my.enum.of.Goodness' })
  // console.log(JSON.stringify(enumModel, null, 2))
  t.end()
})
