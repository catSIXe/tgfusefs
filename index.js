const { v4: uuidv4 } = require('uuid')
// #tgfusefs:dirData:fileName:fuseData:attributes
const { Airgram, Auth, prompt, toObject } = require( 'airgram' )
const airgram = require('./airgram')
const G_UID = process.getuid ? process.getuid() : 0
const G_GID = process.getgid ? process.getgid() : 0
const FILEMODE = {
  RO: 33024,
  400: 33024,
  444: 33060,
  666: 33206,
  777: 33279,
  PRWRR: 4516, // Pipe
}
const cachePrefix = new Date().valueOf()
airgram.use(new Auth({
  code: () => prompt(`Please enter the secret code:\n`),
  phoneNumber: () => prompt(`Please enter your phone number:\n`),
  password: () => prompt(`Please enter your pw:\n`)
}))
const cacheManager = require('cache-manager')
const CACHE = memoryCache = cacheManager.caching({store: 'memory', max: 100, ttl: 10/*seconds*/});

const virtualPipes = {}
const virtualUploads = {}
const virtualUploadMap = []
//const virtualUploadMapReverse = {}


const fuse = require('node-fuse-bindings')
const mountPath = '/home/user/telegram'
/**
 * mkdir /tgfusefstmp
 * mount -t tmpfs -o size=1G,nr_inodes=10k,mode=777 tmpfs /tgfusefstmp
*/
const tempMountPath = '/home/user/temp'

const fs = require('fs')
const path = require('path')

async function main() {
    const me = toObject(await airgram.api.getMe())
    console.log(`[Me] `, me.id)
    const chats = toObject(await airgram.api.getChats({
        chatList: { _: 'chatListMain' },
        limit: 100,
    }))
    /*let uploadFileRequest = await toObject(airgram.api.sendMessage({
      chatId: 777000,
      inputMessageContent: {
          _: 'inputMessageDocument',
          document: { _: 'inputFileLocal', path: '/root/test' },
          caption: {
              _: 'formattedText',
              text: `#tgfusefs💾${ 'test.fifo' }`
          }
      },
    }))
    console.log('uploadFileRequest', uploadFileRequest)*/
    /*{
      file: {
        _: 'inputFileGenerated',
        originalPath: '',
        conversion: '#tgfuse',
        expectedSize: 0,
      },
      fileType: {
        _: 'fileTypeDocument'
      },
      priority: 15,
    }*/
    console.log('Done')
    //process.exit(0)
}

const EventEmitter = require('events');
class TGFileUploadEmitter extends EventEmitter {}
const tgFileUploadEmitter = new TGFileUploadEmitter()

const asyncRedis = require("async-redis")
const client = asyncRedis.createClient()

airgram.on('updateMessageSendAcknowledged', ({ update }) => {
  console.log(update)
})
airgram.on('updateMessageSendFailed', ({ update }) => {
  console.log(update)
  tgFileUploadEmitter.emit(`failed:${ update.oldMessageId }`, update)
})
airgram.on('updateMessageSendSucceeded', ({ update }) => {
  //console.log(update)
  tgFileUploadEmitter.emit(`finished:${ update.oldMessageId }`, update)
})
airgram.on('uploadFile', ({ update }) => {
    console.log(update)
})

const resolveAndCache = (name, resolver, cacheTime=60) => memoryCache.wrap(name, resolver, { ttl: cacheTime })
const sleep = (ms) => new Promise(res => setTimeout(res, ms))

async function getAllFiles(chatId, query, resourceLocator, offset, totalMessages) {
  if (!totalMessages) totalMessages = []
  console.log(query)
  let messages = await resolveAndCache(`files:${ resourceLocator }:${ offset }`, async () => {
    await sleep(500)
    console.log(`renewing cache entry for "files:${ resourceLocator }:${ offset }", newttl=${ !!offset ? 5 : 10 }`)
    return toObject(await airgram.api.searchChatMessages({
      chatId,
      filter: { _: 'searchMessagesFilterEmpty' },
      limit: !!offset ? 100 : 50,
      fromMessageId: offset || 0,
      query,
    })).messages
  }, !!offset ? 5 : 10)
  let lastMessageID
  for (let message of messages) lastMessageID = message.id
  totalMessages = totalMessages.concat(messages)

  if (!!lastMessageID) {
    return await getAllFiles(chatId, query, resourceLocator, lastMessageID, totalMessages)
  }
  return totalMessages
}
const folder2FilterType = {
  'ALL': 'searchMessagesFilterEmpty',
  'animation': 'searchMessagesFilterAnimation',
  'audio': 'searchMessagesFilterAnimation',
  'document': 'searchMessagesFilterDocument',
  'photo': 'searchMessagesFilterPhoto',
  'video': 'searchMessagesFilterVideo',
  'voicenote': 'searchMessagesFilterVoiceNote',
  'photoandvideo': 'searchMessagesFilterPhotoAndVideo'
}


function getStatusHTML() {
  return '<pre>html test</pre>\n'
}

function getContentSize(content) {
  switch (content._) {
    case 'messagePhoto': return getContentFileID(content.photo)
    case 'photo': return getContentFileID(content.photo.size[content.photo.size.length - 1])
    case 'photoSize': return getContentFileID(content.photo)

    case 'messageAudio': return getContentSize(content.audio)
    case 'audio': return getContentSize(content.audio)

    case 'messageDocument': return getContentSize(content.document)
    case 'document': return getContentSize(content.document)

    case 'messageVideo': return getContentSize(content.video)
    case 'video': return getContentSize(content.video)

    case 'file': return content.size
  }
}
function getContentFileID(content) {
  switch (content._) {
    case 'messagePhoto': return getContentFileID(content.photo)
    case 'photo': return getContentFileID(content.photo.size[content.photo.size.length - 1])
    case 'photoSize': return getContentFileID(content.photo)

    case 'messageAudio': return getContentFileID(content.audio)
    case 'audio': return getContentFileID(content.audio)

    case 'messageDocument': return getContentFileID(content.document)
    case 'document': return getContentFileID(content.document)

    case 'messageVideo': return getContentFileID(content.video)
    case 'video': return getContentFileID(content.video)

    case 'file': return content.id // getContentFileID(content.remote)
    // case 'remoteFile': return content.id
  }
}

const chatDirs = {}
async function getDirDataFromChat(chatId) {
  //console.log('getDirDataFromChat', chatId)
  let indexes = toObject(await airgram.api.searchChatMessages({
    chatId,
    // filter: { _: 'sea' },
    limit: 1,
    fromMessageId: 0,
    query: `#tgfuseindex`,
  })).messages
  if (indexes.length === 1) {
    chatDirs[chatId] = JSON.parse(indexes[0].content.text.text.split('\n')[1]) || []
  } else {
    chatDirs[chatId] = []
  }
}
async function saveDirDataToChat(chatId) {
  //console.log('saveDirDataToChat', chatId)
  let indexes = toObject(await airgram.api.searchChatMessages({
    chatId,
    // filter: { _: 'sea' },
    limit: 1,
    fromMessageId: 0,
    query: `#tgfuseindex`,
  })).messages
  //console.log('saveDirDataToChat indexes.length', indexes.length)
  chatDirs[chatId] = chatDirs[chatId] || []
  if (indexes.length > 0) {
    let deleteResponse = await airgram.api.deleteMessages({
      chatId,
      messageIds: indexes.map(x => x.id),
      revoke: true,
    })
    //console.log('deleting old msg', chatId)
  }
  let newIndexResponse = toObject(await airgram.api.sendMessage({
    chatId,
    inputMessageContent: {
      _: 'inputMessageText',
      text: {
        _: 'formattedText', text: `#tgfuseindex\n${ JSON.stringify(chatDirs[chatId]) }`
      }
    },
  }))
  //console.log('saveDirDataToChat', newIndexResponse)
}
function getDirData(path, notAFileName=false) {
  //if (path.split('/').length === 4) return path.split('/')[3]
  // const p = require('path').parse(path.split('/').splice(3))
  let p = path.split('/').splice(3).map(x => Buffer.from(x).toString('base64')).join('/')
  p = p.length === 0 ? '$' : p
  console.log('getDirData', path, p)
  return p
}
let fdCounter = 0
const FD_RANGE = { REAL: 10, VIRTUAL: 50 }
function getFDHandle(offset) {
  fdCounter = (fdCounter + 1) % 30
  console.log('[FD HANDLER] next handle is ', fdCounter+ offset )
  return fdCounter + offset 
}
fuse.mount(mountPath, {
  readdir: async (path, cb)  => {
    const p = require('path').parse(path), 
          deepness = p.dir.substring(1).split('/').length
    console.log(deepness, p, p.dir.substring(1).split('/'))

    console.log('readdir(%s)', path)
    if (path === '/') { // first folder
      let chatList = await resolveAndCache('chatList', async () => {
        return toObject(await airgram.api.getChats({
          offsetOrder: '9223372036854775807',
          offsetChatId: 0,
          limit: 500
        })).chatIds
      })
      return cb(0, ['status.html'].concat(chatList))
    }
    // Chat ID Directorys
    if (deepness === 1 && path.split('/').length == 2) {
      return cb(0, ['title', 'json', 'root'])
    }
    // Chat FilterType Files Directorys
    if (deepness >= 1 && path.split('/').length >= 3 && path.indexOf('root') > 0) {
      // console.log('every folder in the chatfolder, listing the files corresponding to the type')
      const chatId = parseInt(p.dir.split('/')[1])
      await resolveAndCache(`dirIndex:${ chatId }`, async () => await getDirDataFromChat(parseInt(chatId)))
      let dirs = chatDirs[chatId] || []
      const dirData = getDirData(path, true)
      console.log('[VDIR] dirs=', dirs, '| dirData=', dirData)
      dirs = dirs.filter(dirName => {
        if (dirData === '$') return dirName.indexOf('/') === -1
        console.log(dirName, dirName.split('/').length, dirData, dirData.split('/').length)
        return dirName.length > dirData.length &&
         dirName.indexOf(dirData) === 0 && 
         dirName.split('/').length === dirData.split('/').length + 1
      })
      .map(x => {
        x = x.indexOf('/') === -1 ? x : x.split('/')[x.split('/').length - 1]
        return Buffer.from(x, 'base64').toString('utf8')
      })

      let files = await getAllFiles(parseInt(p.dir.substr(1)), `#tgfusefs:${ dirData }${ dirData === '$' ? ':' : ''}`, `${ p.dir }:${ p.base }`)
      //console.log(`files:${ p.dir }:${ p.base }`, files)
      // files folder folder
      console.log('---')
      return cb(0, files.map(message => {
        // console.log(message.content.caption.text.split(':'))
        return Buffer.from(message.content.caption.text.split(':')[2], 'base64').toString('utf8')
      }).concat(dirs))
    }
    return cb(0, [])
  },
  mkdir: async (path, mode, cb) => {
    console.log('mkdir(%s, %d)', path, mode)
    const p = require('path').parse(path), 
          deepness = p.dir.substring(1).split('/').length
    try {
      const chatId = parseInt(p.dir.split('/')[1])
      if (deepness >= 1 && path.split('/').length > 3 && path.indexOf('root') > 0) {
        const dirData = getDirData(path, true)
        console.log('mkdir', chatId, path, dirData)
        chatDirs[chatId] = chatDirs[chatId] || []
        if (chatDirs[chatId].indexOf(dirData) < 0) {
          chatDirs[chatId].push(dirData)
          await saveDirDataToChat(chatId)
          await client.set(cachePrefix+'-'+chatId+'-'+dirData, 1)
        }
      }
      return cb(0)
    } catch (e) {
      console.error(e)
      return cb(fuse.ENOENT)
    }
  },
  rmdir: async (path, cb) => {
    console.log('rmdir(%s)', path)
    const p = require('path').parse(path), 
          deepness = p.dir.substring(1).split('/').length
    try {
      const chatId = parseInt(p.dir.split('/')[1])
      if (deepness >= 1 && path.split('/').length > 3 && path.indexOf('root') > 0) {
        const dirData = getDirData(path, true)
        console.log('rmdir', chatId, path, dirData)
        chatDirs[chatId] = chatDirs[chatId] || []
        if (chatDirs[chatId].indexOf(dirData) > -1) {
          chatDirs[chatId].splice(chatDirs[chatId].indexOf(dirData), 1)
          await saveDirDataToChat(chatId)
          await client.set(chatId+'-'+dirData, 0)
        }
      }
      return cb(0)
    } catch (e) {
      console.error(e)
      return cb(fuse.ENOENT)
    }
  },
  getattr: async (path, cb) => {
    if (!!virtualPipes[path]) {
      return cb(0, {
        mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID,
        nlink: 1, mode: FILEMODE[666], // fifo pipe
        size: 10,
      })
    }
    if (path === '/status.html') {
      return cb(0, {
        mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID,
        nlink: 1, mode: FILEMODE[444],
        size: getStatusHTML().length,
      })
    }
    try {
      const p = require('path').parse(path), 
            deepness = p.dir.substring(1).split('/').length
      const chatId = parseInt(p.dir.split('/')[1])
      console.log('getattr(%s)', path, deepness, path.split('/').length, 'chatId=' + chatId)
      if (!!chatId && chatId > 0) {
        await resolveAndCache(`dirIndex:${ chatId }`, async () => await getDirDataFromChat(chatId))
        const dirData = getDirData(path, true)
        console.log ('VDIR DATA SEARCHED', dirData, chatDirs[chatId] || [])
        let existInCache = false
        try {
          existInCache = await client.get(cachePrefix+'-'+chatId+'-'+dirData) == 1
          console.log('existInCache', existInCache)
        } catch (e) { }
        if (existInCache || (chatDirs[chatId] || []).indexOf(dirData) > -1 ) {
          console.log('[VDIR] emulating', path, existInCache, (chatDirs[chatId] || []).indexOf(dirData))
          console.log('---')
          return cb(0, {
            mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID,
            nlink: 1,
            size: 0,
            mode: 16877, // dir
          })
        }
      }
      if (deepness === 1 && p.name === 'title' && p.ext === '') {
        let title = await resolveAndCache(`title:${ p.dir }`, async () => toObject(await airgram.api.getChat({
            chatId: parseInt(p.dir.substr(1)),
        })).title)
        return cb(0, {
          mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID,
          nlink: 1, mode: FILEMODE[444], // readonly file
          size: title.length + 1, // + 1 for nullbyte
        })
      }
      if (deepness === 1 && p.name === 'json' && p.ext === '') {
        let json = await resolveAndCache(`json:${ p.dir }`, async () => JSON.stringify(toObject(await airgram.api.getChat({
          chatId: parseInt(p.dir.substr(1)),
        })), null, '\t'))
        return cb(0, {
          mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID,
          nlink: 1, mode: FILEMODE[444], // readonly file
          size: json.length + 1, // + 1 for nullbyte
        })
      }
      // every folder in the chatfolder, its size = amount of files in there
      if (deepness === 1 && path.split('/').length == 3 && p.base === 'root') {
        console.log('every folder in the chatfolder, its size = amount of files in there')
        /*if (p.base === 'files') return cb(0, { mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID, nlink: 1, mode: 16877, size: 0, })
        let fileTypeCount = await resolveAndCache(`count:${ p.dir }:${ p.base }`, async () => toObject(await airgram.api.getChatMessageCount({
          chatId: parseInt(p.dir.substr(1)),
          filter: { _: 'searchMessagesFilterEmpty' },
          returnLocal: false
        })).count, 5)
        console.log(`count:${ p.dir }:${ p.base }`, fileTypeCount)
        */
        // files folder folder
        return cb(0, {
          mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID,
          nlink: 1, mode: 16877, // dir
          size: 0,
        })
      }
      if (deepness === 1) { // first folder
        return cb(0, {
          mtime: new Date(), atime: new Date(), ctime: new Date(), uid: G_UID, gid: G_GID,
          nlink: 1,
          size: 0,
          mode: 16877, // dir
        })
      }
      // show file stats for specific file in type dir
      if (deepness >= 2 && path.split('/').length >= 4 && p.dir.split('/')[2] === 'root') {
        const dirData = getDirData(path)
        console.log('dirData', dirData)
        //let files = await getAllFiles(parseInt(p.dir.substr(1)), folder2FilterType[ p.base ], `${ p.dir }:${ p.base }`)
        let getattr = await resolveAndCache(`getattr:${ path }`, async () => {
          const query = `#tgfusefs:${ dirData }:${ Buffer.from(p.base).toString('base64') }:`
          console.log ('searching for ===' + query)
          return toObject(await airgram.api.searchChatMessages({
            chatId,
            // filter: { _: 'sea' },
            limit: 1,
            fromMessageId: 0,
            query,
          })).messages[0]
        }, 15)
        if (!getattr) { console.log('no file found, ', path); return cb(fuse.ENOENT) }
        console.log('---', getattr.id)
        return cb(0, {
          mtime: new Date(getattr.date*1e3), atime: new Date(getattr.date*1e3), ctime: new Date(getattr.date*1e3), uid: G_UID, gid: G_GID,
          nlink: 1, mode: FILEMODE[666], // file
          size: getContentSize(getattr.content),
        })
      }
      // else anything
      console.log('nothing is matching for readdir')
      return cb(fuse.ENOENT)
    } catch (e) {
      console.error(e)
      return cb(fuse.ENOENT)
    }
  },
  open: async (path, flags, cb) => {
    const p = require('path').parse(path), 
          deepness = p.dir.substring(1).split('/').length
    console.log('open(%s, %d)', path, flags)
    if (!!virtualPipes[path]) return cb(0, getFDHandle(FD_RANGE.VIRTUAL)) // virtual file handles are from 50-79
    if (deepness === 1 && p.name === 'title' && p.ext === '') return cb(0, 1)
    if (deepness === 1 && p.name === 'json' && p.ext === '') return cb(0, 2)
    if (path === '/status.html') return cb(0, 4)

    cb(0, getFDHandle(FD_RANGE.REAL)) // real file handles are from 10-39
  },
  read: async (path, fd, buf, len, pos, cb)  => {
    const p = require('path').parse(path), 
          deepness = p.dir.substring(1).split('/').length
    console.log('read(%s, %d, %d, %d)', path, fd, len, pos)
    //console.log(p, deepness)

    if (fd === 1 && deepness === 1 && p.name === 'title' && p.ext === '') {
      let title = await resolveAndCache(`title:${ p.dir }`, async () => toObject(await airgram.api.getChat({
          chatId: parseInt(p.dir.substr(1)),
      })).title)

      let str = title.slice(pos, pos + len)
      if (!str) return cb(0)
      buf.write(str)
      return cb(str.length)
    }
    if (fd === 2 && deepness === 1 && p.name === 'json' && p.ext === '') {
      let json = await resolveAndCache(`json:${ p.dir }`, async () => JSON.stringify(toObject(await airgram.api.getChat({
        chatId: parseInt(p.dir.substr(1)),
      })), null, '\t'))

      let str = json.slice(pos, pos + len)
      if (!str) return cb(0)
      buf.write(str)
      return cb(str.length)
    }
    if (fd >= FD_RANGE.VIRTUAL && !!virtualPipes[path]) {
    }
    if (fd === 4) {
      let str = getStatusHTML().slice(pos, pos + len)
      if (!str) return cb(0)
      buf.write(str)
      return cb(str.length)
    }
    if (fd >= FD_RANGE.REAL && deepness >= 2 && path.split('/').length >= 4 && p.dir.split('/')[2] === 'root') {
      // show file stats for specific file in type dir
      //let files = await getAllFiles(parseInt(p.dir.substr(1)), folder2FilterType[ p.base ], `${ p.dir }:${ p.base }`)
      let getattr = await resolveAndCache(`getattr:${ path }`, async () => toObject(await airgram.api.searchChatMessages({
        chatId: parseInt(p.dir.substr(1)),
        // filter: { _: 'searchMessagesFilterEmpty' },
        limit: 1,
        fromMessageId: 0,
        query: `#tgfusefs:${ getDirData(p.dir) }:${ Buffer.from(p.base).toString('base64') }`,
      })).messages[0], 15)
      let fileId = getContentFileID(getattr.content)
      let downloadRequest = toObject(await airgram.api.downloadFile({
        fileId, priority: 30, offset: pos, limit: len, synchronous: true
      }))
      return fs.open(downloadRequest.local.path, 'r', function(err, fd) {
        //                   /----- where to start writing at in `buffer`    
        fs.readSync(fd, buf, 0, len, pos)
        //                            \------- where to read from in the  file given by `fd`
        return cb(buf.length)
      })
    }

    let str = '< Empty >\n'.slice(pos, pos + len)
    if (!str) return cb(0)
    buf.write(str)
    return cb(str.length)
  },
  release: async (path, fd, cb) => {
    console.log('release(%s, %d)', path, fd)
    if (!!virtualPipes[path]) {
      const virtualPipe = virtualPipes[path]
      console.log(virtualPipes[path])
      fs.closeSync(virtualPipes[path].fd)
      const b64Name = Buffer.from(require('path').parse(virtualPipe.tempTargetFile).base).toString('base64')
      let uploadFileRequest = toObject(await airgram.api.sendMessage({
        chatId: 777000,
        inputMessageContent: {
          _: 'inputMessageDocument',
          document: { _: 'inputFileLocal', path: virtualPipe.tempTargetFile },
          caption: {
            _: 'formattedText', text: `#tgfusefs:${ getDirData(virtualPipe.targetPath) }:${ b64Name }:fuseData:attributes`
          }
        },
      }))

      console.log('uploadFileRequest', uploadFileRequest.sendingState)
      try {
        //console.log(clipJSON)
        tgCloud = await new Promise((res, rej) => {
          tgFileUploadEmitter.removeAllListeners()
          tgFileUploadEmitter.once(`finished:${ uploadFileRequest.id }`, res)
          tgFileUploadEmitter.once(`failed:${ uploadFileRequest.id }`, rej)
        })
        // console.log('upload emitter', tgCloud)
      } catch (e) {
        console.error(e)
        return cb(fuse.ENOENT)
      }
      fs.unlinkSync(virtualPipes[path].tempTargetFile)
      // uploadFile
      delete virtualPipes[path]
      return cb(0)
    }
    return cb(0)
  },
  unlink: async (path, cb) => {
    try {
      const p = require('path').parse(path), 
          deepness = p.dir.substring(1).split('/').length
      console.log('unlink(%s)', path)

      if (deepness === 2 && path.split('/').length == 4 && p.dir.split('/')[2] === 'root') {
        let unlink = await resolveAndCache(`unlink:${ path }`, async () => toObject(await airgram.api.searchChatMessages({
          chatId: parseInt(p.dir.substr(1)),
          filter: { _: folder2FilterType[ p.dir.split('/')[2] ] },
          limit: 1,
          fromMessageId: 0,
          query: `#tgfusefs💾${ Buffer.from(p.base).toString('base64') }`,
        })).messages[0], 15)
        let deleteResponse = await airgram.api.deleteMessages({
          chatId: parseInt(p.dir.substr(1)),
          messageIds: [ unlink.id ],
          revoke: true,
        })
        return cb(0)
      }
    } catch (e) {
      return cb(fuse.ENOENT)
    }
    return cb(fuse.ENOENT)
  },
  rename: async (src, dest, cb) => {
    console.log('rename(%s, %s)', src, dest)
    return cb(fuse.ENOENT)
  },
/*
    if (deepness === 2 && path.split('/').length == 4 && ['ALL', 'animation', 'audio', 'document', 'photo', 'video', 'voicenote', 'photoandvideo'].indexOf(p.dir.split('/')[2]) > - 1) {
      let rename = await resolveAndCache(`rename:${ path }`, async () => toObject(await airgram.api.searchChatMessages({
        chatId: parseInt(p.dir.substr(1)),
        filter: { _: folder2FilterType[ p.dir.split('/')[2] ] },
        limit: 1,
        fromMessageId: 0,
        query: `#tgfusefs💾${ p.base }`,
      })).messages[0], 15)
      let deleteREsponse = await airgram.api.deleteMessages({
        chatId: parseInt(p.dir.substr(1)),
        messageIds: [ rename.id ],
        revoke: true,
      })
      return cb(0)
    }
    return cb(fuse.ENOENT)
  },*/
  create: async (path, mode, cb) => {
    const p = require('path').parse(path), 
          deepness = p.dir.substring(1).split('/').length
    console.log('create(%s, %d)', path, mode)
    if (deepness >= 2 && path.split('/').length >= 4 && p.dir.split('/')[2] === 'root') {
      //createdFiles[path] = true
      let cUUID = uuidv4()
      const tempTargetFile = require('path').join(tempMountPath, path)
      const mkdirp = require('mkdirp')
      await mkdirp(require('path').parse(tempTargetFile).dir)
      console.log('tempTargetFile', tempTargetFile)
      if (fs.existsSync(tempTargetFile)) fs.unlinkSync(tempTargetFile)
      return fs.open(tempTargetFile, 'wx', (err, fd) => {
        if (err) return console.error(err, cb(fuse.ENOENT))
        virtualUploads[cUUID] = path
        virtualPipes[path] = {
          path,
          targetPath: path,
          mode,
          cUUID,
          size: 0,
          tempTargetFile,
          fd
        }
        let virtFd = virtualUploadMap.push(path)
        return cb(0, virtFd)
      })
/*
      let uploadFileRequest = await toObject(airgram.api.sendMessage({
        chatId: 777000,
        inputMessageContent: {
          _: 'inputMessageDocument',
          document: { _: 'inputFileLocal', expectedSize: 0, originalPath },
          caption: {
            _: 'formattedText',
            text: `#tgfusefs💾${ p.base }`
          }
        },
      }))
      let virtFd = virtualUploadMap.push(fifoPath)
      return cb(0, virtFd)
      console.log('uploadFileRequest', uploadFileRequest)
*/
      /*
      return tgFileUploadEmitter.once('genStartCB'+cUUID, (genId) => {
        //virtualUploadMapReverse[genId] = mapIndex
        console.log('file gen created', `genid=${ genId } | virtFd=${ virtFd }`)
        cb(0, virtFd)
      })*/
      //tgFileUploadEmitter.once('genStartFail'+cUUID, () => cb(fuse.ENOENT))
      // return cb(0, 123)
    }
    return cb(fuse.ENOENT)
  },
  write: async (path, fd, buffer, length, position, cb) => {
    // console.log('write(%s, %d, buffer, %d, %d)', path, fd, length, position)
    // console.log('writing', buffer.slice(0, length))
    try {
      const bytesWritten = fs.writeSync(virtualPipes[path].fd, buffer, 0, buffer.length, position)
      return cb(bytesWritten)
    } catch (e) {
      console.error(e)
      return cb(fuse.ENOENT)
    }
  },




}, (err) => {
  if (err) throw err
  console.log('filesystem mounted on ' + mountPath)
})

process.on('SIGINT', function () {
  fuse.unmount(mountPath, function (err) {
    if (err) {
      console.log('filesystem at ' + mountPath + ' not unmounted', err)
    } else {
      console.log('filesystem at ' + mountPath + ' unmounted')
    }
  })
})



console.log(new Date())
main()
