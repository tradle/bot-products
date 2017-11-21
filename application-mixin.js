const co = require('co').wrap
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

    return this.bot.sign(application)
  }

  target.saveApplication = co(function* ({ user, application }) {
    if (user) {
      this.state.updateApplicationStub({ user, application })
    }

    return yield Promise.all([
      this.bot.objects.put(application),
      this.bot.save(application)
    ])
  })
}
