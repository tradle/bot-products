
const test = require('tape')
const Promise = require('bluebird')
const co = Promise.coroutine
const rawCreateBot = require('@tradle/bots').bot
const buildResource = require('@tradle/build-resource')
const baseModels = require('@tradle/models/models')
const createProductsStrategy = require('../')
const models = require('./fixtures/agemodels')
const {
  genEnumModel,
  // genMyProductModel,
  // getApplicationModels
} = require('../utils')

const TYPE = '_t'
const PRODUCT_APPLICATION = 'tradle.ProductApplication'
const CURRENT_ACCOUNT = 'tradle.CurrentAccount'
const FORM_REQ = 'tradle.FormRequest'

function createBot (opts) {
  opts.inMemory = true
  return rawCreateBot(opts)
}

const series = co(function* (arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    yield fn(arr[i])
  }
})

test('basic form loop', co(function* (t) {
  const bot = createBot({
    send: co(function* send ({ userId, object }) { })
  })

  const productModels = [
    // built-in
    baseModels[CURRENT_ACCOUNT],
    // custom
    {
      type: 'tradle.Model',
      id: 'tradle.TestProduct',
      title: 'Test Product',
      interfaces: ['tradle.Message'],
      subClassOf: 'tradle.FinancialProduct',
      forms: [
        'tradle.ORV',
        'tradle.AboutYou'
      ],
      properties: {}
    }
  ]

  const productsStrategy = createProductsStrategy({
    namespace: 'test.namespace',
    models: toObject(productModels),
    products: productModels.map(model => model.id)
  })

  bot.use(productsStrategy)
  bot.start()

  series(productModels, co(function* (productModel) {
    receive({
      [TYPE]: productsStrategy.models.application.id,
      product: {
        id: productModel.id
      }
    })

    const formsTogo = productModel.forms.slice()
    while (formsTogo.length) {
      let nextForm = formsTogo.shift()
      yield new Promise(resolve => {
        bot.once('sent', function ({ user, object }) {
          t.equal(object[TYPE], FORM_REQ)
          t.equal(object.form, nextForm)
          resolve()
        })
      })

      receive({
        [TYPE]: nextForm
      })
    }

    // get product cert
    yield new Promise(resolve => {
      bot.once('sent', function ({ user, object }) {
        const certModel = productsStrategy.models.certificateForProduct[productModel.id]
        t.equal(object[TYPE], certModel.id)
        resolve()
      })
    })
  }))

  t.end()

  function receive (object) {
    bot.receive({
      author: 'ted',
      object: { object },
      objectinfo: { link: 'something' }
    })

    return new Promise(resolve => {
      bot.once('message', resolve)
    })
  }
}))

function toObject (models) {
  const obj = {}
  models.forEach(model => obj[model.id] = model)
  return obj
}

// test('genModels', function (t) {
//   const enumModel = genEnumModel({ models, id: 'my.enum.of.Goodness' })
//   // console.log(JSON.stringify(enumModel, null, 2))
//   t.end()
// })
