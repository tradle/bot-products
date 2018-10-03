const _ = require('lodash')
const co = require('co').wrap
const uuid = require('uuid/v4')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const validateResource = require('@tradle/validate-resource')
const { parseStub, parseId, omitVirtual, omitBacklinks, pickBacklinks, isBacklinkProperty } = validateResource.utils
const {
  ensureLinks,
  debug,
  getContext,
  getLinkFromResourceOrStub,
  getCertificateModelId,
} = require('./utils')

const baseModels = require('./base-models')
const { VERIFICATION, APPLICATION, SUBMISSION } = require('./types')
const verificationModel = baseModels[VERIFICATION]
const stateModels = require('./state-models')
const STATUS = {
  started: 'started',
  completed: 'completed',
  approved: 'approved',
  denied: 'denied'
}

module.exports = function stateMutater ({ bot, models }) {

  const bizModels = models.biz
  const allModels = models.all
  const build = model => buildResource({ model, models: allModels })

  function validateCustomer (user) {
    user[TYPE] = stateModels.customer.id
    validateResource({
      models: allModels,
      model: stateModels.customer,
      resource: user
    })
  }

  function getCertificateModel (productModelId) {
    const model = bizModels.certificateFor[productModelId]
    if (model) return model

    const productModel = allModels[productModelId]
    const certModelId = getCertificateModelId({ productModel })
    return allModels[certModelId]
  }

  function createCertificate ({ application }) {
    const { requestFor, forms } = application
    const certModel = getCertificateModel(requestFor)
    // const copy = forms
    //   .map(parseStub)
    //   .map(({ type }) => {
    //     const model = allModels[type]
    //     return Object.keys(model.properties)
    //       .filter(propertyName => propertyName in certModel.properties)
    //       // need to lookup form bodies for this
    //       .map(propertyName => form[propertyName])
    //   })

    // return build(certModel)
    //   .set('myProductId', uuid())
    //   .toJSON()

    const cert = {
      [TYPE]: certModel.id,
      myProductId: uuid()
    }

    const ownerProp = certModel.properties.owner
    if (ownerProp && ownerProp.ref === 'tradle.Identity') {
      cert.owner = application.applicant
    }

    return cert
  }

  /**
   * add certificate to application state
   * @param {User}             options.user
   * @param {application} options.application
   * @param {Certification}    options.certificate
   */
  function addCertificate ({ user, application, certificate }) {
    const idx = getApplicationStubIndex({
      applications: user.applications,
      application
    })

    if (idx === -1) {
      const certIdx = getApplicationStubIndex({
        applications: user.applicationsApproved,
        application
      })

      if (certIdx === -1) {
        throw new Error('application not found')
      }

      throw new Error('application was already approved')
    }

    // lookup, modify stored version
    const updated = buildResource({
        models: allModels,
        model: stateModels.application,
        resource: application,
        mutate: true
      })
      .set({
        certificate,
        dateEvaluated: Date.now()
      })
      .toJSON()

    _.extend(application, updated)
    setApplicationStatus({ application, status: STATUS.approved })
    addToBacklink(user.applicationsApproved, user.applications[idx])
    user.applications.splice(idx, 1)
    validateCustomer(user)
    return application
  }

  function moveToDenied ({ user, application }) {
    const idx = getApplicationStubIndex({
      applications: user.applications,
      application
    })

    if (idx === -1) {
      throw new Error('application not found')
    }

    addToBacklink(user.applicationsDenied, user.applications[idx])
    user.applications.splice(idx, 1)
    validateCustomer(user)
    return application
  }

  // const revokeCertificate = ({ user, application }) => {
  //   application.certificate
  // }

  function setProfile ({ user, object }) {
    const { firstName, lastName } = object.profile
    // const oldFirstName = user.firstName
    user.firstName = firstName
    if (lastName) {
      user.lastName = lastName
    }
  }

  function importVerification ({ user, application, verification }) {
    addVerification({ user, application, verification, imported: true })
  }

  function addSubmission ({ application, submission }) {
    const { submissions=[] } = application
    if (submission[TYPE] !== SUBMISSION) {
      submission = createSubmission({ application, submission })
    }

    const { permalink } = parseStub(submission.submission)
    const idx = submissions.findIndex(appSub => parseStub(appSub.submission).permalink === permalink)
    if (idx === -1) {
      addToBacklink(submissions, submission)
    } else {
      submissions[idx] = submission
    }

    // in case it was empty
    application.submissions = submissions
    organizeSubmissions(application)
    return application
  }

  function createSubmission ({ application, submission }) {
    return build(stateModels.submission)
      .set({
        application,
        submission,
        context: application.context,
        _time: submission._time
      })
      .toJSON()
  }

  function organizeSubmissions (application) {
    let { submissions=[] } = application
    // time desc
    application.submissions = submissions = submissions.sort((a, b) => b._time - a._time)
    const good = submissions.filter(sub => allModels[sub.submission[TYPE]])
    if (good.length !== submissions.length) {
      bot.logger.warn('could not find models for some submissions', _.difference(submissions, good).map(s => s.submission))
    }

    const types = good.map(s => s.submission[TYPE])
    const models = types.map(t => allModels[t])
    application.forms = good.filter((sub, i) => models[i].subClassOf === 'tradle.Form')
    application.verifications = good.filter((sub, i) => types[i] === VERIFICATION)
    // application.checks = good.filter((sub, i) => models[i].subClassOf === 'tradle.Check')
    application.editRequests = good.filter((sub, i) => types[i] === 'tradle.FormError')
    return application
  }

  function createApplication ({ user, object }) {
    const { requestFor } = object
    const application = build(stateModels.application)
      .set({
        applicant: user.identity,
        context: getContext({
          model: allModels[object[TYPE]],
          resource: object
        }),
        request: object,
        requestFor,
        forms: []
      })
      .toJSON()

    setApplicationStatus({ application, status: 'started' })
    return application
  }

  function updateApplicationStub ({ user, application }) {
    const updated = [
      user.applications,
      user.applicationsApproved,
      user.applicationsDenied
    ].some(applications => {
      const idx = getApplicationStubIndex({ applications, application })
      if (idx !== -1) {
        applications[idx] = createApplicationStub({ application })
        return true
      }
    })

    if (!updated) {
      throw new Error('no matching application stub found')
    }
  }

  function getApplicationStubIndex ({ applications, application }) {
    return applications.findIndex(application2 => {
      return application._permalink === application2.statePermalink
    })
  }

  function hasApplication ({ applications, application }) {
    return getApplicationStubIndex({ applications, application }) !== -1
  }

  function createApplicationStub ({ application }) {
    const copy = Object.keys(stateModels.applicationStub.properties)
      .filter(propertyName => propertyName in stateModels.application.properties)

    return build(stateModels.applicationStub)
      .set(_.pick(application, copy))
      .set({
        statePermalink: buildResource.permalink(application)
      })
      .toJSON()
  }

  function updateApplication ({ application, properties={} }) {
    if (!properties.dateModified) {
      properties.dateModified = Date.now()
    }

    return _.extend(application, properties)

    // const backlinks = pickBacklinks({
    //   model: allModels[APPLICATION],
    //   resource: application
    // })

    // const clean = omitBacklinks({
    //   model: allModels[APPLICATION],
    //   resource: application
    // })

    // buildResource.set({
    //   models: models.all,
    //   model: stateModels.application,
    //   resource: clean,
    //   properties
    // })

    // buildResource.setVirtual(clean, {
    //   _time: properties.dateModified
    // })

    // return _.extend(application, clean)
  }

  function setApplicationStatus ({ application, status }) {
    if (status === application.status) return

    const now = Date.now()
    const properties = { status, dateModified: now }
    switch (status) {
    case STATUS.completed:
      properties.dateCompleted = now
      break
    case STATUS.started:
      properties.dateStarted = now
      break
    case STATUS.approved:
    case STATUS.denied:
      properties.dateEvaluated = now
      break
    default:
      throw new Error(`invalid application status: ${status}`)
    }

    updateApplication({ application, properties })
    return application
  }

  function isApplicationCompleted (application) {
    return application.status === 'completed'
  }

  /**
   * add application state
   * @param {User}             options.user
   * @param {Application Form} options.object  [description]
   * @param {tradle.Message}   options.message [description]
   */
  function addApplication ({ user, application }) {
    ensureLinks(application)
    debug('added application with context: ' + application.context)
    const stub = createApplicationStub({ application })
    addToBacklink(user.applications, stub)
    validateCustomer(user)
    return stub
  }

  const createVerification = co(function* ({ application, object, verification={} }) {
    const oLink = getLinkFromResourceOrStub(object)
    const builder = build(verificationModel)
      .set(verification)
      .set('document', object)

    if (!verification.dateVerified) {
      builder.set('dateVerified', Date.now())
    }

    if (!verification.sources && application) {
      const { verifications=[] } = application
      const vBodies = yield Promise.all(verifications.map(v => bot.objects.get(v.submission._link)))
      const sources = vBodies.filter(v => parseStub(v.document).link === oLink)
      if (sources.length) {
        builder.set('sources', sources)
      }
    }

    return cleanVerification(builder.toJSON())
  })

  function addVerification ({ application, verification }) {
    if (!(application && verification)) {
      throw new Error('expected "application" and "verification"')
    }

    addSubmission({ application, submission: verification })

    // if (imported) {
    //   if (!application.verificationsImported) {
    //     application.verificationsImported = []
    //   }

    //   application.verificationsImported.push(vItem)
    // } else {
    //   if (!application.verificationsIssued) {
    //     application.verificationsIssued = []
    //   }

    //   application.verificationsIssued.push(vItem)
    // }

    // validateCustomer(user)
    // return verification
  }

  // function addForm ({ user, object, application }) {
  //   if (!application.forms) {
  //     application.forms = []
  //   }

  //   const stub = buildResource.stub({
  //     models: allModels,
  //     resource: object
  //   })

  //   const formPermalink = buildResource.permalink(object)
  //   const productModel = allModels[application.requestFor]
  //   const { multiEntryForms=[] } = productModel
  //   const idx = application.forms.findIndex(form => {
  //     const { type, permalink } = parseStub(form)
  //     if (permalink === formPermalink) return true
  //     if (type === object[TYPE] && !multiEntryForms.includes(type)) {
  //       // e.g. we don't want multiple tradle.Selfie forms, just the last one
  //       return true
  //     }
  //   })

  //   if (idx === -1) {
  //     application.forms.push(stub)
  //   } else {
  //     application.forms[idx] = stub
  //   }

  //   validateCustomer(user)
  //   return stub
  // }

  function init (user) {
    const { properties } = stateModels.customer
    for (let propertyName in properties) {
      let prop = properties[propertyName]
      if (prop.type === 'array' && !isBacklinkProperty(prop)) {
        if (!user[propertyName]) {
          user[propertyName] = []
        }
      }
    }
  }

  function setIdentity ({ user, identity }) {
    user.identity = buildResource.stub({
      models: allModels,
      resource: identity
    })
  }

  function findApplication (applications, test) {
    return applications.find(test)
  }

  function getApplicationByContext (applications, context) {
    return findApplication(applications, application => application.context === context)
  }

  const getApplicationsByType = (applications, type) =>
    applications.filter(application => application.requestFor === type)

  const getSubmissionsByType = (submissions, type) => submissions.filter(appSub => {
    return parseStub(appSub.submission).type === type
  })

  const createFilterForType = query => ({ type }) => type === query

  function getLatestForm (forms, filter) {
    let result
    forms.slice().reverse().some(appSub => {
      const parsed = parseStub(appSub.submission)
      if (filter(parsed)) {
        result = parsed
        return true
      }
    })

    return result
  }

  const getLatestFormByType = (forms, type) =>
    getLatestForm(forms, createFilterForType(type))

  function guessApplicationFromIncomingType (applications, type) {
    return findApplication(applications, app => {
      const productModel = models.all[app.requestFor]
      return productModel.forms.indexOf(type) !== -1
    })
  }

  function getApplicationContext (application) {
    return application.context
  }

  return {
    createApplication,
    addApplication,
    createCertificate,
    addCertificate,
    createVerification,
    addSubmission,
    createSubmission,
    createApplicationStub,
    updateApplicationStub,
    setApplicationStatus,
    moveToDenied,
    updateApplication,
    // addForm,
    validateCustomer,
    setProfile,
    setIdentity,
    init,
    getSubmissionsByType,
    getLatestForm,
    getLatestFormByType,
    hasApplication,
    getApplicationsByType,
    getApplicationByContext,
    findApplication,
    guessApplicationFromIncomingType,
    getApplicationContext,
    newRequestState,
    isApplicationCompleted,
    organizeSubmissions,
    status: STATUS
  }
}

function newRequestState (data) {
  const payload = data.payload || data.object
  return _.extend({}, data, {
    sendQueue: [],
    object: payload,
    payload,
    type: data.type || (payload && payload[TYPE])
  })
}

function cleanVerification (v) {
  v = omitVirtual(v)
  if (v.sources) v.sources = v.sources.map(cleanVerification)

  return v
}

function addToBacklink (backlink, item) {
  // order by time desc
  backlink.unshift(item)
}
