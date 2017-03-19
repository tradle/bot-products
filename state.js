exports.addVerification = addVerification

function addVerification ({ state, verification, verifiedItem }) {
  if (verifiedItem.id) {
    verifiedItem = verifiedItem.id
  }

  if (typeof verifiedItem === 'string') {
    verifiedItem = parseId(verifiedItem)
  }

  const { link, permalink, object } = verifiedItem
  const type = verifiedItem.type || object[TYPE]
  if (!state[permalink]) state[permalink] = []

  state.push({ type, link, permalink, verification })
}