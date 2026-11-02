const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['state.get','project.create','project.update','chat.create','chat.update','chat.send','chat.stop','chat.archive','provider.save','provider.test','approval.resolve','tool.run','settings.update','extensions.reload','voice.start','voice.stop','voice.speak','voice.status','app.openPath','app.restart','app.reloadUI','app.uiState','app.uiStateAck','models.state','models.search','models.inspect','models.download','models.cancel','models.settings.save','models.chooseDirectory','models.openDirectory','models.openPage','localModels.list','localModels.start','localModels.stop']);
contextBridge.exposeInMainWorld('sophia',{
  request(method,params={}){if(!allowed.has(method))return Promise.reject(new Error('Unknown bridge request'));return ipcRenderer.invoke('sophia:request',method,params);},
  subscribe(listener){if(typeof listener!=='function')throw new Error('Listener must be a function');const receive=(_event,payload)=>listener(payload);ipcRenderer.on('sophia:event',receive);return()=>ipcRenderer.removeListener('sophia:event',receive);}
});
