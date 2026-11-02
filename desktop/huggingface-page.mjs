export function huggingFacePage(value){
  const url=new URL(value);
  if(url.origin!=='https://huggingface.co'||url.username||url.password||url.search||url.hash||url.href!==value||!/^\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.pathname))throw new Error('Only canonical Hugging Face model pages can be opened');
  return url.href;
}
