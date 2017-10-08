
const {
  co,
  createSimpleMessage
} = require('./utils')

const STRINGS = require('./strings')

module.exports = Commander

function Commander (api) {
  this.api = api
}

const proto = Commander.prototype
proto.exec = co(function* ({ req, command }) {
  let resp
  switch (command) {
  case '/help':
    resp = STRINGS.HELP_MENU
    break
  case '/products':
    return this.api.sendProductList(req)
  case '/forgetme':
    return this.api.forgetUser(req)
  // case '/human':
  //   return this.api.sendProductList(req)
  default:
    resp = STRINGS.DONT_UNDERSTAND
    break
  }

  return this.api.send({
    req,
    object: createSimpleMessage(resp)
  })
})
