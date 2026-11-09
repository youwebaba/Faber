export function installCapturePermissions({session,contents,share,sources,allowFullscreen}){
  const trusted=(owner,details)=>owner&&owner===contents()&&owner.mainFrame.url==='faber://app/index.html'&&details?.isMainFrame===true&&details.requestingUrl==='faber://app/index.html';
  function allowed(owner,permission,details,consume){
    if(allowFullscreen(owner,permission,details))return true;
    if(!trusted(owner,details))return false;
    if(permission==='display-capture')return Boolean(share.capturePermission('screen')||share.capturePermission('window'));
    if(permission!=='media')return false;
    const types=Array.isArray(details.mediaTypes)?details.mediaTypes:[details.mediaType];
    return types.length===1&&types[0]==='video'&&Boolean(share.capturePermission('camera',consume));
  }
  session.setPermissionRequestHandler((owner,permission,callback,details)=>callback(allowed(owner,permission,details,true)));
  session.setPermissionCheckHandler((owner,permission,_origin,details)=>allowed(owner,permission,details,false));
  session.setDisplayMediaRequestHandler((request,respond)=>{
    const owner=contents();
    if(!owner||request.frame!==owner.mainFrame||request.frame.url!=='faber://app/index.html'||!request.videoRequested||request.audioRequested||!request.userGesture)return respond(null);
    const grant=share.capturePermission('screen',true)||share.capturePermission('window',true);
    if(!grant)return respond(null);
    void sources().then(rows=>{
      const still=share.capturePermission('screen')||share.capturePermission('window');
      const source=still?.id===grant.id&&rows.find(row=>row.id===grant.source);
      respond(source?{video:source}:null);
    },()=>respond(null));
  },{useSystemPicker:false});
}
