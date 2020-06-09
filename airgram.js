const { Airgram, Auth, prompt } = require('airgram')
const airgram = new Airgram({
    apiId: 1203086,
    apiHash: '213bcfbdae59ef171d85cade070fc33d',

    useChatInfoDatabase: true,
    useMessageDatabase: true,
    databaseDirectory: './db/',
    useSecretChats: false,
    

    logVerbosityLevel: 2, // 2,

    deviceModel: 'by @cat6e',
    systemVersion: '1.0.0',
    applicationVersion: '1.0.0',
})

module.exports = airgram
