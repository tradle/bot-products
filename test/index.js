if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test'
}

const test = require('tape')
const sinon = require('sinon')
const co = require('co').wrap
const fakeResource = require('@tradle/build-resource/fake')
const buildResource = require('@tradle/build-resource')
const mergeModels = require('@tradle/merge-models')
const { TYPE, SIG } = require('@tradle/constants')
const baseModels = require('../base-models')
const createProductsStrategy = require('../')
const createDefiner = require('../definer')
const { pick } = require('../utils')
const messageInterface = require('../message-interface')
const CURRENT_ACCOUNT = 'tradle.CurrentAccount'
const SELF_INTRODUCTION = 'tradle.SelfIntroduction'
const {
  formLoop,
  loudCo,
  toObject,
  hex32,
  newSig,
  fakeBot,
  createIdentityStub
} = require('./helpers')

const TEST_PRODUCT = {
  type: 'tradle.Model',
  id: 'tradle.TestProduct',
  title: 'Test Product',
  interfaces: [messageInterface],
  subClassOf: 'tradle.FinancialProduct',
  forms: [
    'tradle.ORV',
    'tradle.AboutYou'
  ],
  properties: {}
}

test('definer', function (t) {
  const obj = {}
  let i = 0
  obj.define = createDefiner()
  obj.define('blah', () => i++)
  t.equal(obj.blah, 0)
  // cached
  t.equal(obj.blah, 0)
  obj.blah = undefined

  t.equal(obj.blah, 1)
  // cached
  t.equal(obj.blah, 1)
  t.end()
})

test('addProducts', function (t) {
  const namespace = 'test.namespace'
  const productModels = [TEST_PRODUCT]
  const productsStrategy = createProductsStrategy({
    namespace,
    models: {
      all: toObject(productModels)
    },
    products: productModels.map(model => model.id)
  })

  t.same(productsStrategy.products, [TEST_PRODUCT.id])
  t.same(
    productsStrategy.models.biz.productList.enum
      .sort(compareId),
    productModels
      .map(model => pick(model, ['id', 'title']))
      .sort(compareId)
  )

  productModels.push(baseModels['tradle.CurrentAccount'])
  productsStrategy.addProducts({
    products: productModels.map(model => model.id)
  })

  t.same(
    productsStrategy.models.biz.productList.enum
      .sort(compareId),
    productModels
      .map(model => pick(model, ['id', 'title']))
      .sort(compareId)
  )


  t.end()
})

test('state', loudCo(function* (t) {
  const namespace = 'test.namespace'
  const identityStub = createIdentityStub()
  const user = {
    id: 'bob',
    identity: identityStub
  }

  const productModel = TEST_PRODUCT
  const productModels = [productModel]
  const productsStrategy = createProductsStrategy({
    namespace,
    models: {
      all: toObject(productModels)
    },
    products: productModels.map(model => model.id)
  })

  const { bot } = fakeBot({ user })
  const {
    state,
    models,
  } = productsStrategy.install(bot)

  const privateModels = models.private
  const productRequest = fakeResource({
    models: models.all,
    model: models.biz.productRequest,
    signed: true
  })

  state.init(user)
  t.same(user, {
    id: user.id,
    identity: identityStub,
    roles: [],
    applications: [],
    applicationsApproved: [],
    applicationsDenied: [],
    // forms: [],
    importedVerifications: [],
    issuedVerifications: []
  })

  const application = yield bot.sign(state.createApplication({
    user,
    object: productRequest
  }))

  state.addApplication({ user, application })

  productModel.forms.forEach((form, i) => {
    const link = hex32()
    const signedForm = fakeResource({
      models: models.all,
      model: models.all[form],
      signed: true
    })

    state.addForm({
      user,
      application,
      object: signedForm,
      type: form,
      link,
      permalink: link,
    })

    if (i === 0) {
      state.importVerification({
        user,
        object: createSignedVerification({ user, state, form: signedForm })
      })
    }

    state.addVerification({
      user,
      verification: createSignedVerification({ user, state, form: signedForm })
    })
  })

  t.equal(user.applications.length, 1)
  t.equal(user.applicationsApproved.length, 0)
  t.equal(user.applicationsDenied.length, 0)
  t.ok(user.applications.every(f => f[TYPE] === privateModels.applicationStub.id))

  const certificate = state.createCertificate({ application })
  certificate[SIG] = newSig()

  state.addCertificate({
    req: state.newRequestState({ user, application }),
    certificate
  })

  t.equal(user.applications.length, 0)
  t.equal(user.applicationsApproved.length, 1)
  t.equal(user.issuedVerifications.length, productModel.forms.length)
  t.equal(user.importedVerifications.length, 1)
  // t.equal(user.forms.length, productModel.forms.length)
  // t.ok(user.forms.every(f => f[TYPE] === privateModels.formState.id))
  t.ok(user.applicationsApproved.every(f => f[TYPE] === privateModels.applicationStub.id))

  t.end()
}))

test('basic form loop', loudCo(function* (t) {
  const products = [CURRENT_ACCOUNT, 'tradle.TestProduct']
  const {
    bot,
    api,
    applyForProduct,
    awaitBotResponse,
    receiveFromUser,
    plugins,
    models,
    user
  } = formLoop({
    products,
    models: mergeModels()
      .add(baseModels)
      .add([TEST_PRODUCT])
      .get()
  })

  // api.plugins.use({
  //   onmessage: require('../keep-models-fresh')({
  //     getModelsForUser: function (user) {
  //       return models.all
  //     },
  //     send: ({ user, object }) => api.send(user, object)
  //   })
  // }, true)

  const productModels = products.map(id => models.all[id])
  let pluginsCalled
  plugins.use({
    'onmessage:tradle.Form': function ({ type }) {
      if (pluginsCalled) {
        pluginsCalled.onForm[type] = (pluginsCalled.onForm[type] || 0) + 1
      }
    },
    shouldSealReceived: function ({ object }) {
      const type = object[TYPE]
      if (pluginsCalled) {
        pluginsCalled.shouldSealReceived[type] =
          (pluginsCalled.shouldSealReceived[type] || 0) + 1
      }
    },
    shouldSealSent: function ({ object }) {
      const type = object[TYPE]
      if (pluginsCalled) {
        pluginsCalled.shouldSealSent[type] =
          (pluginsCalled.shouldSealSent[type] || 0) + 1
      }
    }
  }, true)

  api.removeDefaultHandler('onFormsCollected')

  const testProduct = co(function* ({ productModel, approve }) {
    api.plugins.clear('onFormsCollected')
    // api.plugins.clear('shouldSealSent')
    // api.plugins.clear('shouldSealReceived')
    plugins.use({
      onFormsCollected: function (req) {
        const { user, application } = req
        t.notOk(pluginsCalled.onFormsCollected[application.requestFor])
        pluginsCalled.onFormsCollected[application.requestFor] = true
        const action = approve ? api.approveApplication : api.denyApplication
        return action.call(this, { req })
      }
    })

    pluginsCalled = {
      onForm: {},
      shouldSealSent: {},
      shouldSealReceived: {},
      onFormsCollected: {}
    }

    let { request, response } = yield applyForProduct({ productModel })
    const { context } = request
    const forms = productModel.forms.slice()
    const bad = {
      [forms[0]]: true
    }

    for (let i = 0; i < forms.length; i++) {
      let nextForm = forms[i]
      t.equal(response.object.form, nextForm)
      let result = yield receiveFromUser({
        object: fakeResource({
          models: models.all,
          model: models.all[nextForm]
        }),
        context
      })

      if (bad[nextForm]) {
        // user corrects form
        api.requestEdit({
          req: api.state.newRequestState({
            user,
            object: result.request.object,
          }),
          details: {
            message: 'dude, seriously',
            errors: []
          }
        })

        yield awaitBotResponse('tradle.FormError')
        bad[nextForm] = false
        result = yield receiveFromUser({
          object: fakeResource({
            models: models.all,
            model: models.all[nextForm]
          }),
          context
        })
      }

      response = result.response
      yield api.verify({
        req: api.state.newRequestState({
          user
        }),
        object: result.request.object
      })

      yield awaitBotResponse('tradle.Verification')
      let done = i === forms.length - 1
      let app
      let expectedStatus
      if (done) {
        expectedStatus = approve ? 'approved' : 'denied'
        const applications = approve ? user.applicationsApproved : user.applicationsDenied
        app = api.state.getApplicationsByType(applications, productModel.id)[0]
      } else {
        expectedStatus = 'started'
        app = api.state.getApplicationsByType(user.applications, productModel.id)[0]
      }

      t.ok(app)
      const appState = yield api.getApplicationByStub(app)
      t.same(appState.status, expectedStatus)
      t.ok(api.state.getFormsByType(appState.forms, nextForm).length > 0)
    }

    // get product cert
    const respType = response.object[TYPE]
    if (approve) {
      t.equal(respType, models.biz.certificateFor[productModel.id].id)
      t.same(user.applicationsApproved[0].status, 'approved')
    } else {
      t.equal(respType, 'tradle.ApplicationDenial')
      t.same(user.applicationsDenied[0].status, 'denied')
    }

    // yield wait(100)

    // list of product is also a FormRequest
    t.equal(pluginsCalled.shouldSealSent['tradle.FormRequest'], productModel.forms.length + 1)
    t.equal(pluginsCalled.shouldSealSent['tradle.FormError'], Object.keys(bad).length)
    t.equal(pluginsCalled.shouldSealSent['tradle.Verification'], productModel.forms.length)
    t.equal(pluginsCalled.shouldSealSent[respType], 1)

    // t.ok(productModel.id in user.products)
    // t.same(user.applications[productModel.id], [])

    productModel.forms.forEach(form => {
      t.equal(pluginsCalled.onForm[form], form in bad ? 2 : 1)
      t.equal(pluginsCalled.shouldSealReceived[form], form in bad ? 2 : 1)
    })

    t.same(pluginsCalled.onFormsCollected, {
      [productModel.id]: true
    })

    const forgotYou = yield receiveFromUser({
      object: fakeResource({
        models: models.all,
        model: models.all['tradle.ForgetMe']
      }),
      awaitResponse: true
    })

    t.equal(forgotYou.response.object[TYPE], 'tradle.ForgotYou')
    // t.same(Object.keys(user), ['id', 'identity'])

    // productModel.forms.forEach(form => {
    //   const idx = user.forms.findIndex(formState => {
    //     return formState.type === form
    //   })

    //   t.equal(idx, -1)
    // })
  })

  const selfIntroResp = yield receiveFromUser({
    object: fakeResource({
      models: models.all,
      model: models.all[SELF_INTRODUCTION]
    }),
    awaitResponse: true
  })

  for (let productModel of productModels) {
    yield testProduct({ productModel, approve: true })
    yield testProduct({ productModel, approve: false })
  }

  t.end()
}))

test('plugins', loudCo(function* (t) {
  const productModels = [
    baseModels[CURRENT_ACCOUNT]
  ]

  const productsStrategy = createProductsStrategy({
    namespace: 'test.namespace',
    models: {
      all: toObject(productModels)
    },
    products: productModels.map(model => model.id)
  })

  const bot = {
    use: (strategy, opts) => strategy(bot, opts),
    onmessage: () => {},
    onusercreate: () => {}
  }

  const productsAPI = productsStrategy.install(bot)
  productsAPI.plugins.clear('getRequiredForms')
  productsAPI.plugins.use({
    getRequiredForms: function () {
      return ['blah']
    }
  })

  t.same(productsAPI.plugins.exec('getRequiredForms'), ['blah'])

  productsAPI.plugins.clear('getRequiredForms')
  productsAPI.plugins.use({
    getRequiredForms: function () {
      return Promise.resolve(['blah1'])
    }
  })

  t.same(yield productsAPI.plugins.exec('getRequiredForms'), ['blah1'])
  t.end()
}))

test.skip('complex form loop', loudCo(co(function* (t) {
  const bizPlugins = require('@tradle/biz-plugins')
  const corpModels = require('@tradle/models-corporate-onboarding')
  const productModelId = 'tradle.CRSSelection'
  const products = [productModelId]
  const productModel = corpModels[productModelId]
  const {
    bot,
    api,
    applyForProduct,
    awaitBotResponse,
    receiveFromUser,
    plugins,
    models,
    user
  } = formLoop({
    products,
    models: mergeModels()
      .add(baseModels)
      .add(corpModels)
      .get()
  })

  // unshift (put ahead of defaults)
  bizPlugins.forEach(plugin => plugins.use(plugin(), true))

  // const appResult = yield applyForProduct({ productModel })
  const testProduct = co(function* ({ productModel }) {
    let { request, response } = yield applyForProduct({ productModel })
    const { context } = request
    let nextForm
    while (nextForm = response.object.form) {
      console.log(nextForm)
      // t.equal(response.object.form, nextForm)
      let result = yield receiveFromUser({
        object: fakeResource({
          models: models.all,
          model: models.all[nextForm]
        }),
        context
      })

      response = result.response
    }

    t.equal(response.object[TYPE], 'tradle.MyCRSSelection')
    t.end()
  })

  yield testProduct({ productModel })
})))

// test('genModels', function (t) {
//   const enumModel = genEnumModel({ models, id: 'my.enum.of.Goodness' })
//   // console.log(JSON.stringify(enumModel, null, 2))
//   t.end()
// })
//
// process.on('uncaughtException', console.error)

function createSignedVerification ({ state, user, form }) {
  const verification = state.createVerification({
    req: state.newRequestState({
      user
    }),
    object: form
  })

  const vLink = hex32()
  buildResource.setVirtual(verification, {
    _link: vLink,
    _permalink: vLink
  })

  return verification
}

function compareId (a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
