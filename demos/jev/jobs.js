const form=document.getElementById('search'),results=document.getElementById('results');
form.addEventListener('submit',event=>{
  event.preventDefault();
  const {query,location,seniority}=Object.fromEntries(new FormData(form));let count=0;
  for(const job of results.children){
    const matches=job.dataset.keywords.includes(query.trim().toLowerCase())&&(location==='all'||job.dataset.location===location)&&(seniority==='all'||job.dataset.seniority===seniority);
    job.hidden=!matches;if(matches)count++;
  }
  results.dataset.searched='true';document.getElementById('summary').textContent=`${count} jobs · Filters applied`;
});
