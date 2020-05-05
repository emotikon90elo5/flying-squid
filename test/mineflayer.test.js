/* eslint-env jest */

const squid = require('flying-squid')
const settings = require('../config/default-settings')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

function assertPosEqual (actual, expected) {
  expect(actual.distanceTo(expected)).toBeLessThan(1)
}

const once = require('event-promise')

const { firstVersion, lastVersion } = require('./common/parallel')

squid.supportedVersions.forEach((supportedVersion, i) => {
  if (!(i >= firstVersion && i <= lastVersion)) {
    return
  }

  const mcData = require('minecraft-data')(supportedVersion)
  const version = mcData.version

  const Item = require('prismarine-item')(supportedVersion)

  describe('server with mineflayer connection ' + version.minecraftVersion, () => {
    jest.setTimeout(100 * 1000)
    let bot
    let bot2
    let serv
    let entityName

    async function onGround (bot) {
      await new Promise((resolve) => {
        const l = () => {
          if (bot.entity.onGround) {
            bot.removeListener('move', l)
            resolve()
          }
        }
        bot.on('move', l)
      })
    }

    async function waitMessage (bot, message) {
      const msg1 = await once(bot, 'message')
      expect(msg1.extra[0].text).toEqual(message)
    }

    async function waitMessages (bot, messages) {
      const toReceive = messages.reduce((acc, message) => {
        acc[message] = 1
        return acc
      }, {})
      const received = {}
      return new Promise(resolve => {
        const listener = msg => {
          const message = msg.extra[0].text
          if (!toReceive[message]) throw new Error('Received ' + message + ' , expected to receive one of ' + messages)
          if (received[message]) throw new Error('Received ' + message + ' two times')
          received[message] = 1
          if (Object.keys(received).length === messages.length) {
            bot.removeListener('message', listener)
            resolve()
          }
        }
        bot.on('message', listener)
      })
    }

    async function waitLoginMessage (bot) {
      return Promise.all([waitMessages(bot, ['bot joined the game.', 'bot2 joined the game.'])])
    }

    beforeEach(async () => {
      const options = settings
      options['online-mode'] = false
      options['port'] = 0
      options['view-distance'] = 2
      options['worldFolder'] = undefined
      options['logging'] = false
      options['version'] = version.minecraftVersion
      options['generation'] = { // TODO: fix block tests failing at random without manually specifying seed
        name: 'diamond_square',
        options: {
          seed: 2116746182
        }
      }

      serv = squid.createMCServer(options)
      if (serv.supportFeature('entityCamelCase')) {
        entityName = 'EnderDragon'
      } else {
        entityName = 'ender_dragon'
      }

      await once(serv, 'listening')
      const port = serv._server.socketServer.address().port
      bot = mineflayer.createBot({
        host: 'localhost',
        port: port,
        username: 'bot',
        version: version.minecraftVersion
      })
      bot2 = mineflayer.createBot({
        host: 'localhost',
        port: port,
        username: 'bot2',
        version: version.minecraftVersion
      })

      await Promise.all([once(bot, 'login'), once(bot2, 'login')])
      bot.entity.onGround = false
      bot2.entity.onGround = false
    })

    afterEach(async () => {
      await serv.quit()
    })

    function waitSpawnZone (bot, view) {
      const nbChunksExpected = (view * 2) * (view * 2)
      let c = 0
      return new Promise(resolve => {
        const listener = () => {
          c++
          if (c === nbChunksExpected) {
            bot.removeListener('chunkColumnLoad', listener)
            resolve()
          }
        }
        bot.on('chunkColumnLoad', listener)
      })
    }

    describe('actions', () => {
      test('can dig', async () => {
        await Promise.all([waitSpawnZone(bot, 2), waitSpawnZone(bot2, 2), onGround(bot), onGround(bot2)])

        const pos = bot.entity.position.offset(0, -1, 0).floored()
        bot.dig(bot.blockAt(pos))

        let [, newBlock] = await once(bot2, 'blockUpdate', { array: true })
        assertPosEqual(newBlock.position, pos)
        expect(newBlock.type).toEqual(0)
      })

      test('can place a block', async () => {
        await Promise.all([waitSpawnZone(bot, 2), waitSpawnZone(bot2, 2), onGround(bot), onGround(bot2)])

        const pos = bot.entity.position.offset(0, -2, 0).floored()
        bot.dig(bot.blockAt(pos))

        let [, newBlock] = await once(bot2, 'blockUpdate', { array: true })
        assertPosEqual(newBlock.position, pos)
        expect(newBlock.type).toEqual(0)

        bot.creative.setInventorySlot(36, new Item(1, 1))
        await new Promise((resolve) => {
          bot.inventory.on('windowUpdate', (slot, oldItem, newItem) => {
            if (slot === 36 && newItem && newItem.type === 1) { resolve() }
          })
        })

        bot.placeBlock(bot.blockAt(pos.offset(0, -1, 0)), new Vec3(0, 1, 0));

        [, newBlock] = await once(bot2, 'blockUpdate', { array: true })
        assertPosEqual(newBlock.position, pos)
        expect(newBlock.type).toEqual(1)
      })

      test('can open and close a chest', async () => {
        await Promise.all([waitSpawnZone(bot, 2), onGround(bot), waitSpawnZone(bot2, 2), onGround(bot2)])

        const chestId = mcData.blocksByName['chest'].id
        const [ x, y, z ] = [1, 2, 3]

        const states = {
          open: {
            location: { x, y, z },
            byte1: 1,
            byte2: 1, // open
            blockId: chestId
          },
          closed: {
            location: { x, y, z },
            byte1: 1,
            byte2: 0, // closed
            blockId: chestId
          }
        }

        bot.chat(`/setblock ${x} ${y} ${z} ${chestId} 2`) // place a chest facing north

        await once(bot, 'blockUpdate')

        bot.chat(`/setblockaction ${x} ${y} ${z} 1 1`) // open the chest

        const [ blockActionOpen ] = await once(bot._client, 'block_action', { array: true })
        const [ blockActionOpen2 ] = await once(bot2._client, 'block_action', { array: true })
        expect(blockActionOpen).toEqual(states.open)
        expect(blockActionOpen2).toEqual(states.open)

        bot.chat(`/setblockaction ${x} ${y} ${z} 1 0`) // close the chest

        const [ blockActionClosed ] = await once(bot._client, 'block_action', { array: true })
        const [ blockActionClosed2 ] = await once(bot2._client, 'block_action', { array: true })
        expect(blockActionClosed).toEqual(states.closed)
        expect(blockActionClosed2).toEqual(states.closed)
      })
    })

    describe('commands', () => {
      jest.setTimeout(60 * 1000)
      test('has an help command', async () => {
        await waitLoginMessage(bot)
        bot.chat('/help')
        await once(bot, 'message')
      })
      test('can use /particle', async () => {
        bot.chat('/particle 5 10 100 100 100')
        await once(bot._client, 'world_particles')
      })
      test('can use /playsound', async () => {
        bot.chat('/playsound ambient.weather.rain')
        await once(bot, 'soundEffectHeard')
      })

      function waitDragon () {
        return new Promise((resolve) => {
          const listener = (entity) => {
            if (entity.name === entityName) {
              bot.removeListener('entitySpawn', listener)
              resolve()
            }
          }
          bot.on('entitySpawn', listener)
        })
      }

      test('can use /summon', async () => {
        bot.chat('/summon ' + entityName)
        await waitDragon()
      })
      test('can use /kill', async () => {
        bot.chat('/summon ' + entityName)
        await waitDragon()
        bot.chat('/kill @e[type=' + entityName + ']')
        const entity = await once(bot, 'entityDead')
        expect(entity.name).toEqual(entityName)
      })
      describe('can use /tp', () => {
        test('can tp myself', async () => {
          bot.chat('/tp 2 3 4')
          await once(bot, 'forcedMove')
          assertPosEqual(bot.entity.position, new Vec3(2, 3, 4))
        })
        test('can tp somebody else', async () => {
          bot.chat('/tp bot2 2 3 4')
          await once(bot2, 'forcedMove')
          assertPosEqual(bot2.entity.position, new Vec3(2, 3, 4))
        })
        test('can tp to somebody else', async () => {
          await onGround(bot)
          bot.chat('/tp bot2 bot')
          await once(bot2, 'forcedMove')
          assertPosEqual(bot2.entity.position, bot.entity.position)
        })
        test('can tp with relative positions', async () => {
          await onGround(bot)
          const initialPosition = bot.entity.position.clone()
          bot.chat('/tp ~1 ~-2 ~3')
          await once(bot, 'forcedMove')
          assertPosEqual(bot.entity.position, initialPosition.offset(1, -2, 3))
        })
        test('can tp somebody else with relative positions', async () => {
          await Promise.all([onGround(bot), onGround(bot2)])
          const initialPosition = bot2.entity.position.clone()
          bot.chat('/tp bot2 ~1 ~-2 ~3')
          await once(bot2, 'forcedMove')
          assertPosEqual(bot2.entity.position, initialPosition.offset(1, -2, 3))
        })
      })
      test('can use /deop', async () => {
        await waitLoginMessage(bot)
        bot.chat('/deop bot')
        await waitMessage(bot, 'bot is deopped')
        bot.chat('/op bot')
        await waitMessage(bot, 'You do not have permission to use this command')
        serv.getPlayer('bot').op = true
      })
      test('can use /setblock', async () => {
        await Promise.all([waitSpawnZone(bot, 2), onGround(bot)])
        bot.chat('/setblock 1 2 3 95 0')
        let [, newBlock] = await once(bot, 'blockUpdate:' + new Vec3(1, 2, 3), { array: true })
        expect(newBlock.type).toEqual(95)
      })
      test('can use /xp', async () => {
        bot.chat('/xp 100')
        await once(bot, 'experience')
        expect(bot.experience.points).toEqual(100)
      })
    })
  })
})
