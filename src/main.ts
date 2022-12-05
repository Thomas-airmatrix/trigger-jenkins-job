import * as core from '@actions/core'
const axios = require('axios');

const jenkins_server: string = core.getInput("jenkins-server")
const jenkins_job: string = core.getInput("jenkins-job")
const jenkins_username: string = core.getInput("jenkins-username")
const jenkins_pat: string = core.getInput("jenkins-pat")
const API_TOKEN = Buffer.from(`${jenkins_username}:${jenkins_pat}`).toString('base64');
let headers = {
 'Authorization': `Basic ${API_TOKEN}`,
 'Accept-Encoding': 'gzip'
}
const sleep = (milliseconds: number) => {
 return new Promise(resolve => setTimeout(resolve, milliseconds))
}
async function poll_build(url: string): Promise<number> {
 for (let i = 0; i < 20; i++) {
  await sleep(2500)
  let job = await axios({
   method: 'get',
   url: `${url}/api/json`,
   headers: headers,
  });
  core.info(`Job starting: ${job.data?.why || "Job Spawning"}`)

  if (job.data.blocked) {
   throw "Request Blocked"
  }
  let build = job?.data?.executable?.number
  if (build != null) {
   return build
  }
 }
 throw "Timeout"
}

function split_once(input: string, pat: string): [string, string] {
 let idx = input.indexOf(pat)
 if (idx < 0) {
  return ["", input]
 } else {
  return [input.slice(0,idx), input.slice(idx+pat.length)]
 }
}

async function build_info(build_number:number ) {
 let job = await axios({
  method: 'get',
  url: `${jenkins_server}/job/${jenkins_job}/${build_number}/api/json`,
  headers: headers,
 });
 return job.data
}
type LogData = {
    last_command: string;
    stages: number;
}
async function log(build_number:number ): Promise<LogData> {

 let data = {
  last_command: "",
  stages: 0,
  last_stage: -1,
 }
 let job = await axios({
  method: 'get',
  url: `${jenkins_server}/job/${jenkins_job}/${build_number}/timestamps/?appendLog`,
  headers: headers,
 });
 let prev_s = ""
 let scnt = 0;
 let failover = 1000000000; 
 let l = 0; 
 for (const line of job.data.split("\n")) {
  l+=1;
  if (line.endsWith(" skipped due to earlier failure(s)")) {
   failover = l - 2;
  }
 }
 l=0;
 for (const line of job.data.split("\n")) {
  l+=1;
  const [time_str, rest] = split_once(line, "  ")
  const ps = prev_s;
  prev_s = ""
  if (rest.startsWith("[Pipeline] ")) {
   prev_s = rest.slice("[Pipeline] ".length).trim()
   if (ps === "stage") {
    data.stages += 1;
    if (data.last_stage == -1 && l >= failover) {
     data.last_stage = data.stages
    }
    if (l<failover){
     const stage_name = prev_s.replace(/[^ a-zA-Z0-9\-]/g, '').trim()
     console.log(`::group::${stage_name}`)
    }
   }
   if (ps === '}' && prev_s == "// stage") {
    if (l < (failover+1)) {
     console.log(`::end::group`)
    }
   }
   continue
  }
  if (ps=="sh" && rest.startsWith("+ ")) {
   data.last_command = rest.slice(2)
  }
  console.log(rest)
 }
 return data
}

async function run(): Promise<void> {
 try {
  let ref = process.env["GITHUB_REF"]
  if (ref == null) {
   core.warning("Missing GITHUB_REF env var");
   return;
  }
  let matches = ref.match(/refs\/pull\/([0-9]*)\/merge/);
  if (matches == null || matches.length < 2) {
   core.warning(`Not running on PR, GITHUB_REF=${ref}`);
   return;
  }
  let pr_num = matches[1];
  core.info(`Starting Job ${jenkins_job} with branch=${ref} pr=${pr_num}`)
  core.info(`> ${jenkins_server}/job/${jenkins_job}/buildWithParameters`);
  let x = await axios({
   method: 'post',
   url: `${jenkins_server}/job/${jenkins_job}/buildWithParameters`,
   headers: { 'Content-Type': 'application/x-www-form-urlencoded',  
              'Authorization': `Basic ${API_TOKEN}`},
   data: `branch=${encodeURIComponent(ref)}&pull_request=${encodeURIComponent(pr_num)}`,
   maxRedirects: "0",
  });
  let job_id = await poll_build(x.headers['location'])
  let est = 5000;
  for (let i = 0; i < 1000; i++) {
   await sleep(est)
   let info = await build_info(job_id)
   if (info.inProgress) {
    continue;
   }
   let data = await log(job_id)
   if (info.result === "SUCCESS") {
    core.summary.addHeading(`All ${data.stages} stages passed`)
    await core.summary.write()
   } else {
    core.setFailed(`${info.result}: Last command: ${data.last_command}`)
   }
   return;
  }
  
  // core.setOutput('time', new Date().toTimeString())
 } catch (error) {
  if (error instanceof Error) core.setFailed(error.message)
 }
}

run()
