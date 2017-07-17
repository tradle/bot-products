const { TYPE } = require('@tradle/engine').constants
const { parseId } = require('./utils')

exports.addVerification = addVerification

function addVerification ({ state, verification, verifiedItem }) {
  if (verifiedItem.id) {
    verifiedItem = verifiedItem.id
  }

  const { type, link, permalink } = getInfo(verifiedItem)
  if (!state[permalink]) state[permalink] = []

  state[permalink].push({ type, link, permalink, verification })
}

function getInfo (objOrId) {
  if (typeof verifiedItem === 'string') {
    return parseId(verifiedItem)
  }

  return {
    link: objOrId._link,
    permalink: objOrId._permalink,
    type: objOrId[TYPE],
  }
}
