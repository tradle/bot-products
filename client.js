const { EventEmitter } = require('events')
const typeforce = require('typeforce')
const inherits = require('inherits')
const { TYPE } = require('@tradle/constants')
const validateResource = require('@tradle/validate-resource')
const { omitVirtual, getRef, parseStub } = validateResource.utils
const buildResource = require('@tradle/build-resource')
// const ModelManger = require('./models')
const baseModels = require('./base-models')
const createStateMutater = require('./state')
const applicationMixin = require('./application-mixin')
const {
  APPLICATION,
  PRODUCT_REQUEST,
  MODELS_PACK
} = require('./types')

const {
  co,
  bindAll,
  getModelsPacks
} = require('./utils')

const notNull = val => !!val

exports = module.exports = opts => new Client(opts)

function Client () {
  EventEmitter.call(this)
  bindAll(this)
  applicationMixin(this)

  // this.models = new ModelManger({ namespace })
  this.state = createStateMutater({ models: baseModels })
}

inherits(Client, EventEmitter)
const proto = Client.prototype

proto.install = function (bot) {
  this.bot = bot
  this._promiseIdentityPermalink = this.bot.getMyIdentity()
    .then(identity => buildResource.permalink(identity))

  this.uninstall = this.bot.hook('messagestream:post', this.processMessages)
  this.emit('bot', bot)
  return this
}

proto.getModelsPacks = function ({ from, to }) {
  return getModelsPacks({ db: this.bot.db, from, to })
}

proto.processMessages = co(function* ({ messages }) {
  // TODO: handle inbound...though that couples it to the provider implementation
  const outbound = messages.filter(({ _inbound }) => !_inbound)
  if (!outbound.length) return

  // outbound.sort(byTime)
  // const minDate = outbound[0]._time
  // const maxDate = outbound[outbound.length - 1]
  // const modelsPacks = yield this.getModelsPacks({
  //   from: minDate,
  //   to: maxDate
  // })

  // ignore those without contexts
  const byContext = groupBy(outbound, 'context')
  const drafts = Object.keys(byContext).map(context => {
    const messages = byContext[context]
    const draft = {
      [TYPE]: APPLICATION,
      context,
      forms: []
    }

    for (const message of messages) {
      const payload = message.object
      if (message._payloadType === PRODUCT_REQUEST) {
        draft.requestFor = payload.requestFor
      } else {
        draft.forms.push(stubWithoutModel(payload))
      }
    }

    if (draft.requestFor || draft.forms.length) {
      return draft
    }
  }).filter(notNull)

  if (!drafts.length) return

  const contexts = drafts.map(({ context }) => context)
  const existingApplications = yield this.bot.db.find({
    EQ: {
      [TYPE]: APPLICATION,
      _author: yield this._promiseIdentityPermalink
    },
    IN: {
      context: contexts
    }
  })

  existingApplications.forEach(application => {
    const { context } = application
    const idx = drafts.findIndex(app => app.context == context)
    const draft = drafts[idx]
    drafts.splice(idx, 1)

    // recent first
    application.forms = draft.forms.concat(application.forms || [])
    application.forms = uniqBy(application.forms, getPermalinkFromStub)
    return application
  })

  const saveNewApplications = drafts
    .map(application => this.saveApplication({ application }))

  const saveUpdatedApplications = existingApplications
    .map(application => this.saveNewVersionOfApplication({ application }))

  yield Promise.all(saveNewApplications.concat(saveUpdatedApplications))
})

const groupBy = (arr, prop) => {
  const groups = {}
  for (const el of arr) {
    const group = el[prop]
    if (!group) continue

    if (!groups[group]) {
      groups[group] = []
    }

    groups[group].push(el)
  }

  return groups
}

const byTime = (a, b) => a._time - b._time

const flatten = arr => {
  return arr.reduce((all, some) => all.concat(some), [])
}

const stubWithoutModel = (resource) => {
  return {
    id: buildResource.id({
      resource
    }),
    title: resource[TYPE]
  }
}

const uniqBy = (arr, getUniqueId) => {
  const have = {}
  return arr.filter(item => {
    const id = getUniqueId(item)
    if (!have[id]) {
      have[id] = true
      return true
    }
  })
}

const getPermalinkFromStub = stub => parseStub(stub).permalink
