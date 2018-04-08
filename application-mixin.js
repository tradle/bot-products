const co = require('co').wrap
const { PREVLINK } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const { parseStub } = require('./utils')

module.exports = function applicationMixin (target) {

  /**
   * update PERMALINK, PREVLINK on application, save new application version
   */
  target.saveNewVersionOfApplication = function ({ user, application }) {
    return this.createNewVersionOfApplication(application)
      .then(application => this.saveApplication({ user, application }))
  }

  target.createNewVersionOfApplication = function (application) {
    application = buildResource.version(application)
    this.state.updateApplication({
      application,
      properties: {
        dateModified: Date.now()
      }
    })

    return target.sign(application)
  }

  target.saveApplication = co(function* ({ user, application }) {
    // application._time = application.dateModified
    if (!user) {
      const { permalink } = parseStub(application.applicant)
      user = yield this.bot.users.get(permalink)
    }

    this.state.updateApplicationStub({ user, application })
    // const method = application[PREVLINK] ? 'update' : 'save'
    return this.bot.save(application)
  })
}
