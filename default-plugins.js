const _ = require('lodash')
const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const validateResource = require('@tradle/validate-resource')
const { isSubClassOf } = validateResource.utils
const {
  co,
  isPromise,
  format,
  validateRequired,
  parseStub,
} = require('./utils')

const Commander = require('./commander')
const STRINGS = require('./strings')
const {
  DENIAL,
  APPROVAL,
  VERIFICATION,
  PRODUCT_REQUEST,
  IDENTITY_PUBLISH_REQUEST,
  SELF_INTRODUCTION,
  NEXT_FORM_REQUEST,
  SIMPLE_MESSAGE,
  FORGET_ME,
  FORM,
  MY_PRODUCT,
  REMEDIATION,
  SUBMITTED
} = require('./types')

const TO_SEAL = [
  VERIFICATION.
  CONFIRMATION,
  APPROVAL,
  DENIAL
]

module.exports = function (api) {
  const { models, plugins, state, logger } = api
  const bizModels = models.biz
  const commands = new Commander(api)
  const handleApplication = co(function* (req) {
    const { user, masterUser, allUsers, object, bot } = req
    const { requestFor } = object

    logger.debug(`received application for "${requestFor}"`)
    const isOfferedProduct = bizModels.products.includes(requestFor)
    if (!isOfferedProduct) {
      logger.debug(`ignoring application for "${requestFor}" as it's not in specified offering`)
      return
    }
    let allApplications = []
    if (allUsers)
      allUsers.forEach(user => allApplications.push(...user.applications))

    let pending = state.getApplicationsByType(allApplications, requestFor)
    if (!pending  ||  !pending.length) {
      let users = allUsers &&  allUsers.filter(u => user.id !== u.id)
      let result = users.map(u => state.getApplicationsByType(u.applications || [], requestFor))
      pending = result.find(r => r &&  r.length)
    }
    if (pending  &&  pending.length) {
      yield plugins.exec({
        method: 'onPendingApplicationCollision',
        args: [{ req, pending }]
      })

      return
    }

    if (req.application) {
      // ignore and continue existing application
      //
      // delegate this decision to the outside?
      yield api.continueApplication(req)
      return
    }

    const existingProduct = user.applicationsApproved.find(application => {
      return application.requestFor === object.requestFor
    })

    if (existingProduct) {
      const maybePromise = plugins.exec({
        method: 'onRequestForExistingProduct',
        args: [req]
      })

      if (isPromise(maybePromise)) yield maybePromise
      return
    }

    yield api.addApplication({ req })
  })

  const onPendingApplicationCollision = co(function* ({ req, pending }) {
    const { user } = req
    for (const appStub of pending) {
      try {
        req.application = yield api.getApplicationByStub(appStub)
        break
      } catch (err) {
        logger.error(`application not found by stub: ${JSON.stringify(appStub)}`)
        // user.applications = user.applications.filter(stub => stub.id !== appStub.id)
      }
    }

    const { application } = req
    if (application) {
      req.context = application.context
      logger.debug(`ignoring 2nd request for ${application.requestFor}, one is already pending: ${application._permalink}`)
      if (state.isApplicationCompleted(application)) {
        yield api.send({
          req,
          to: user,
          application,
          object: STRINGS.APPLICATION_IN_REVIEW
        })
      } else {
        yield api.continueApplication(req)
      }

    } else {
      logger.error('ERROR: failed to find colliding application')
    }
  })

  const onRequestForExistingProduct = co(function* (req) {
    // to allow the 2nd application, uncomment:
    // yield api.addApplication({ req })
    const { user } = req
    const type = req.object.requestFor
    const model = models.all[type]
    yield api.send({
      req,
      user,
      object: format(STRINGS.ALREADY_HAVE_PRODUCT, model.title)
    })
  })

  const handleForm = co(function* (req) {
    logger.debug('handleForm start')
    const { user, allUsers, application, object, type, bot } = req
    if (!application) {
      logger.debug('application is unknown, ignoring form')
      return
    }

    if (type === PRODUCT_REQUEST) {
      logger.debug('handleForm', `ignoring ${type} as it's handled by handleApplication`)
      // handled by handleApplication
      return
    }
    let applicantId = parseStub(application.applicant).permalink
    if (user.id !== applicantId  &&  !application.filledForCustomer  &&  !application.draft) {
      let id = allUsers  &&  allUsers.find(user => user.id === applicantId)
      if (!id) {
        logger.debug(`ignoring form submitted by someone other than applicant`)
        return
      }
    }

    const { requestFor, skip=[],  processingDataBundle} = application
    if (processingDataBundle) {
      logger.debug(`processing data bundle for ${requestFor}. No validation is needed`)
      return
    }

    const skipIdx = skip.indexOf(type)
    if (skipIdx !== -1) {
      // unmark as skipped
      // receipt of next tradle.NextFormRequest will re-mark it if needed
      logger.debug(`un-marking ${type} as skippable (for multi-entry)`)
      skip.splice(skipIdx, 1)
    }

    logger.debug('handleForm:validateForm')
    let err = plugins.exec({
      method: 'validateForm',
      args: [{
        req,
        productsAPI: api,
        application,
        form: object
      }],
      returnResult: true
    })

    if (isPromise(err)) err = yield err

    if (err) {
      if (err.exit)
        logger.debug(`handleForm:requestEdit was sent by plugin${err.name ? `: ${err.name}` : ''}`)
      else {
        logger.debug('handleForm:requestEdit')
        yield api.requestEdit({ req, user, application, item: object, details: err })
      }
      return
    }

    logger.debug('handleForm: add form, continueApplication', { form: object[TYPE] })
    let { submission } = api.state.addSubmission({
      application,
      submission: object
    })

    yield api.continueApplication(req)
  })

  function validateForm ({ application, form }) {
    const type = form[TYPE]
    const model = models.all[type]
    if (!model) throw new Error(`unknown type ${type}`)

    let err = validateRequired({ model, resource: form })
    if (!err) {
      if (!form[SIG]) {
        err = {
          message: 'Please review',
          errors: []
        }
      }
    }

    return err
  }

  const handleVerification = req => {
    const missing = ['user', 'application', 'object'].find(key => !req[key])
    if (missing) {
      logger.debug(`inbound verification is likely for a remote application, as I'm missing a key ingredient: ${missing}`)
      return
    }

    const { user, application, object } = req
    return api.importVerification({
      user,
      application,
      verification: object,
      saveApplication: false
    })
  }

  function saveIdentity ({ user, object }) {
    const { identity } = object
    if (buildResource.permalink(identity) === user.id) {
      logger.debug(`saving user ${user.id} identity`)
      // relies on validation of proper versioning elsewhere in the stack
      api.state.setIdentity({ user, identity })
    } else {
      logger.debug(`not saving user ${user.id} identity`)
    }
  }

  const saveName = co(function* (req) {
    const { user, object, application } = req
    if (!object.profile) return

    const { firstName } = user
    api.state.setProfile({ user, object })
    // if (user.firstName !== firstName) {
    //   yield api.send({
    //     req,
    //     object: createSimpleMessage(format(STRINGS.HI_JOE, user.firstName))
    //   })
    // }

    // if (user.firstName) {
    //   application.firstName = user.firstName
    // }

    // if (user.lastName) {
    //   application.lastName = user.lastName
    // }
  })

  function sendApplicationSubmitted ({ req, user, application }) {
    const { context, requestFor, forms, processingDataBundle } = application

    if (processingDataBundle) return

    const message = application.dateCompleted
      ? STRINGS.APPLICATION_UPDATED
      : STRINGS.APPLICATION_SUBMITTED

    let object = buildResource({
      models: models.all,
      model: SUBMITTED
    })
    .set({
      context,
      requestFor,
      forms: _.map(forms, 'submission'),
      message
    })
    .toJSON()

    api._exec('willSaveResource', {application, resource: object})
    return api.send({
      req,
      to: user,
      application,
      object
    })
  }

  const handleSimpleMessage = co(function* (req) {
    const { message } = req.message.object
    if (message[0] === '/') {
      return plugins.exec({
        method: 'onCommand',
        args: [{ req, productsAPI: api, command: message }]
      })
    }

    // return banter(req)
  })

  // const banter = co(function* (req) {
  //   const { object } = req
  //   const tellMeMore = format(STRINGS.TELL_ME_MORE, object.message)
  //   yield api.send({
  //     req,
  //     object: createSimpleMessage(STRINGS.DONT_UNDERSTAND)
  //   })
  // })

  function willRequestForm (opts) {
    if (!opts.formRequest.message) {
      opts.formRequest.message = getFormRequestMessage(opts)
    }
  }

  function getFormRequestMessage ({ application, formRequest }) {
    const { form } = formRequest
    const model = models.all[form]
    if (form === PRODUCT_REQUEST) {
      return STRINGS.PRODUCT_LIST_MESSAGE
    }

    if (!application) {
      return format(STRINGS.PLEASE_FILL_FORM, model.title)
    }

    const { forms=[], requestFor } = application
    const { multiEntryForms=[] } = models.all[requestFor]
    if (isSubClassOf({subModel: models.all[FORM], model, models: models.all})) {
      if (multiEntryForms.includes(form)) {
        const hasOne = forms.find(appSub => parseStub(appSub.submission).type === form)
        return hasOne
          ? format(STRINGS.MULTI_ENTRY_PROMPT, model.title)
          : format(STRINGS.PLEASE_FILL_FORM, model.title)
      }

      return format(STRINGS.PLEASE_FILL_FORM, model.title)
    }


    return STRINGS.PLEASE_GET_THIS_PREREQUISITE_PRODUCT
  }

  function setCompleted ({ application }) {
    if (application.status === state.status.started)
      api.state.setApplicationStatus({ application, status: state.status.completed })
  }

  function shouldSealReceived ({ message, object }) {
    if (object._seal) return false

    const type = object[TYPE]
    const model = models.all[type]
    if (model && isSubClassOf({subModel: models.all[FORM], model, models: models.all}))
      return true
  }

  function shouldSealSent ({ message, object }) {
    if (object._seal) return false

    const type = object[TYPE]
    if (TO_SEAL.includes(type)) return true

    const model = models.all[type]
    if (model && model.subClassOf === MY_PRODUCT) {
      return true
    }
  }

  const didSend = co(function* (...args) {
    const should = yield api._exec({
      method: 'shouldSealSent',
      args,
      allowExit: true,
      returnResult: true
    })

    if (!should) return

    const [sendInput, sendOutput] = args
    const object = sendOutput
    const counterparty = sendInput.to.id || sendInput.to
    yield api.seal({ object, counterparty })
  })

  const willSend = co(function* (opts) {
    let { req, application, to, link, object } = opts
    if (req) {
      if (!application && req.application) {
        application = opts.application = req.application
      }

      if (!to && req.user) {
        to = opts.to = req.user
      }
    }

    if (!(to && (link || object))) {
      throw new Error('expected "to" and "link" or "object"')
    }

    if (link && !object) {
      opts.object = yield api.bot.objects.get(link)
    }
  })

  function deduceApplication (data) {
    const { user, context, type } = data
    if (type === PRODUCT_REQUEST) return

    const { applications=[], applicationsApproved=[] } = user
    let application
    if (context) {
      application = state.getApplicationByContext(applications, context) ||
        state.getApplicationByContext(applicationsApproved, context)

      if (!application) {
        logger.debug(`application with context ${context} not found`)
      }
    } else {
      application = state.guessApplicationFromIncomingType(applications, type) ||
        state.guessApplicationFromIncomingType(applicationsApproved, type)

      if (applicationsApproved.some(appState => appState === application)) {
        // nasty side effect
        data.forCertificate = true
      }
    }

    if (application) {
      logger.debug('deduced current application, context: ' + application.context)
    } else {
      logger.debug(`could not deduce current application`)
    }

    return application
  }

  // const maybeSendProductList = co(function* (req) {
  //   const { user, context } = req
  //   if (context) {
  //     logger.debug('not sending product list in contextual chat')
  //   } else {
  //     yield api.sendProductList({ req, to: user })
  //   }

  //   // const { historySummary=[] } = req.user
  //   // const plLabel = getProductListLabel()
  //   // const productList = historySummary.find(({ label, inbound }) => {
  //   //   return !inbound && label && label.startsWith(STRINGS.PRODUCT_LIST_LABEL)
  //   // })

  //   // if (!(productList && productList.label === plLabel)) {
  //   //   return api.sendProductList(req)
  //   // }

  //   // logger.debug('not sending product list as I sent it recently')
  // })

  // const getProductListLabel = (other={}) => {
  //   const hash = sha256({
  //     products: api.products,
  //     other
  //   }).slice(0, 6)

  //   return STRINGS.PRODUCT_LIST_LABEL + hash
  // }

  // const getMessageLabel = ({ user, message, object, inbound }) => {
  //   const isProductList = !inbound &&
  //     object[TYPE] === FORM_REQUEST &&
  //     object.form === PRODUCT_REQUEST

  //   if (isProductList) {
  //     return getProductListLabel(_.pick(message, ['originalSender']))
  //   }
  // }

  const getNextRequiredItem = ({ req, user, application, productModel, required }) => {
    const { submissions=[], skip=[] } = application
    const { multiEntryForms=[] } = productModel
    const appStatus = [state.status.approved, state.status.denied, state.status.completed]
    return required.find(form => {
      if (multiEntryForms.includes(form)) {
        if (appStatus.indexOf(application.status) !== -1)
          return false
        const idx = skip.indexOf(form)
        if (idx === -1) {
          return form
        }
      }

      if (models.all[form].abstract)
        return !state.getSubmissionsBySubType(submissions, form).length
      else
        return !state.getSubmissionsByType(submissions, form).length
    })
  }

  const breakOutOfMultiEntry = co(function* (req) {
    const { application, payload, type } = req
    if (!application) {
      throw new Error(`application not found, cannot process ${type}`)
    }

    const { requestFor, skip=[] } = application
    const productModel = models.all[requestFor]
    const { multiEntryForms=[] } = productModel
    const { after } = payload
    if (multiEntryForms.includes(after)) {
      if (!skip.includes(after)) {
        logger.debug(`marking ${after} as skippable (for multi-entry)`)
        skip.push(after)
        // in case it was null
        application.skip = skip
      }
    } else {
      logger.debug(`form is not listed in multiEntryForms, ignoring ${type}`, {
        product: requestFor,
        form: after
      })
    }

    return api.continueApplication(req)
  })

  const defaults = {
    // getMessageLabel,
    onCommand: commands.exec.bind(commands),
    deduceApplication,
    willSend,
    didSend,
    shouldSealSent,
    shouldSealReceived,
    getRequiredForms,
    getNextRequiredItem,
    validateForm,
    willRequestForm,
    getFormRequestMessage,
    onPendingApplicationCollision,
    onRequestForExistingProduct,
    onFormsCollected: [
      sendApplicationSubmitted,
      setCompleted,
      // api.approveApplication
    ]
  }

  _.extend(defaults, prependKeysWith('onmessage:', {
    [SELF_INTRODUCTION]: [
      saveIdentity,
      saveName,
      // maybeSendProductList
    ],
    [IDENTITY_PUBLISH_REQUEST]: [
      saveIdentity,
      saveName,
      // maybeSendProductList
    ],
    // 'tradle.Name': saveName,
    [FORM]: handleForm,
    [VERIFICATION]: handleVerification,
    [PRODUCT_REQUEST]: handleApplication,
    [SIMPLE_MESSAGE]: handleSimpleMessage,
    // 'tradle.CustomerWaiting': maybeSendProductList,
    [FORGET_ME]: api.forgetUser,
    [NEXT_FORM_REQUEST]: breakOutOfMultiEntry
    // onUnhandledMessage: noComprendo
  }))

  return defaults
}

function prependKeysWith (prefix, obj) {
  const copy = {}
  for (let key in obj) {
    copy[prefix + key] = obj[key]
  }

  return copy
}

// promisified because it might be overridden by an async function
function getRequiredForms ({ user, application, productModel }) {
  return productModel.forms.slice()
}
