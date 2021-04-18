'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const axios = require('axios')
const qs = require('qs')
const SocksProxyAgent = require('socks-proxy-agent')
const axiosCookieJarSupport = require('axios-cookiejar-support').default
const tough = require('tough-cookie')
const nodemailer = require('nodemailer')

const DEFAULT_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.79 Safari/537.36 Edge/14.14393'
const NET_TV_URL = 'http://net.tv.cn'

let configFile = process.argv[2]
if (!configFile) {
  console.log('Please specify config file')
  process.exit(1)
}
configFile = path.join(process.cwd(), configFile)
const config = require(configFile)

let client
if (config['http'] && config['http'].socksProxy) {
  // create the socksAgent for axios
  const httpAgent = new SocksProxyAgent(config['http'].socksProxy)
  client = axios.create({ withCredentials: true, httpAgent, httpsAgent: httpAgent })
} else {
  client = axios.create({ withCredentials: true })
}
const cookieJar = new tough.CookieJar()
// Set directly after wrapping instance.
axiosCookieJarSupport(client)
client.defaults.jar = cookieJar

async function requestAsync(uri, opts) {
  const headers = {
    'User-Agent': config.userAgent || DEFAULT_USERAGENT
  }
  if (opts && opts.headers) {
    const _headers = Object.assign({ headers }, opts.headers)
    opts = Object.assign({}, opts, { headers: _headers })
  }
  if (opts && opts.data) {
    opts.data = qs.stringify(opts.data)
  }
  if (!opts) {
    opts = {}
  }
  opts.url = uri
  return await client(opts)
}

function checkUrl(_url) {
  if (_url.startsWith('/')) {
    return _url
  }
  if (_url.startsWith('./')) {
    return _url.substr(1)
  }
  if (!/^https?:\/\//.test(_url)) {
    return '/' + _url
  }
  const up = new URL(_url)
  if (up.hostname && !NET_TV_URL.includes(up.hostname.toLowerCase())) {
    return null
  }
  return up.path
}

function trimHtml(content) {
  if (!content) {
    return ''
  }
  return content.replace(/<.*?>/g, '').trim()
}

function getRootItems(callbackName, jsonpData) {
  const startPrefix = callbackName + '('
  let startPos = jsonpData.indexOf(startPrefix)
  if (startPos < 0) {
    throw new Error('failed to valid jsonp data')
  }
  startPos += startPrefix.length
  const endPos = jsonpData.lastIndexOf(')')
  if (endPos < 0) {
    throw new Error('failed to valid jsonp data')
  }
  const data = JSON.parse(jsonpData.substr(startPos, endPos - startPos))
  return data.root
}

function ii(s, len = 2, pad = '0') {
  s = s.toString()
  while (s.length < len) {
    s = pad + s
  }
  return s
}

/**
 * Format date to string
 *
 * @param {Date} d
 * @return {String} eg. '2019-08-04'
 */
function formatDateTime(d) {
  return `${d.getFullYear()}-${ii(d.getMonth() + 1)}-${ii(d.getDate())} ${ii(d.getHours())}:${ii(d.getMinutes())}:${ii(d.getSeconds())}`
}

function sendMail(subject, body) {
  let transOpts = {
    auth: {
      user: config['mail'].username,
      pass: config['mail'].password,
    },
  }
  if (config['mail'].service) {
    transOpts.service = config['mail'].service
  } else {
    transOpts = Object.assign(transOpts, config['mail'].smtp)
  }
  const transporter = nodemailer.createTransport(transOpts)

  const mailOpts = {
    from: config['mail'].sender, // sender address
    to: config['mail'].receiver, // list of receivers
    subject: subject, // Subject line
    text: body, // plain text body
  }

  transporter.sendMail(mailOpts, (err, info) => {
    if (err) {
      return console.log(err)
    }
    console.log('Message %s sent: %s', info.messageId, info.response)
  })
}

function ocrImage(imageFilePath) {
  return new Promise((resolve, reject) => {
    const tesseract = spawn(config.tesseract.command, [imageFilePath, 'stdout', '--psm', '6', '--dpi', '70'])
    let stdout = '', stderr = ''
        tesseract.stdout.on('data', function (data) {
          stdout += data
        })
        tesseract.stderr.on('data', function (data) {
          stderr += data
        })
        tesseract.on('close', function (code) {
          fs.unlink(imageFilePath, function (err) {
            if (err) {
              console.error('unlink png error:', err)
            }
          })
          if (code !== 0) {
            // error
            reject(new Error(stderr))
            return
          }
          stdout = stdout.substr(0, stdout.length - 1).trim().replace(/ /g, '')
          resolve(stdout)
        })
  })
}

async function main() {
  const account = config.account
  if (!account || !account['username'] || !account['password']) {
    throw new Error('config account error')
  }

  let _url = NET_TV_URL + '/'
  let r = await requestAsync(_url)
  if (!r || !r.data.includes('<img id="codeId"')) {
    throw new Error('failed to open homepage')
  }

  let nextUrl = ''
  const maxRetries = 3

  for (let i = 0; i < maxRetries; i++) {
    try {
      nextUrl = NET_TV_URL + '/kaptcha.jpg'
      // captcha
      r = await requestAsync(nextUrl, { headers: { Referer: _url }, responseType: 'arraybuffer' })
      if (!r) {
        throw new Error('failed to get captcha image')
      }

      let vcode = ''
      try {
        const imageFilePath = 'kaptcha-' + Date.now() + '.jpg'
        fs.writeFileSync(imageFilePath, r.data)
        vcode = await ocrImage(imageFilePath)
      } catch (e) {
        throw e
      }

      nextUrl = NET_TV_URL + '/login.do'
      const qs = {
        systemId: 'three',
        method: 'doLogin',
        username: account['username'],
        password: account['password'],
        code: vcode,
        CNNAME: '',
        msg: '',
      }
      r = await requestAsync(nextUrl,
        { method: 'POST', data: qs, maxRedirects: 0, headers: { Referer: _url }, validateStatus: function (status) {
            return status >= 200 && status < 400
          }, })
      if (r) {
        if (r.status !== 302) {
          const m = r.data.match(/<span style="color:red;.*?>(.*?)<\/span>/i)
          if (m) {
            throw new Error(m[1])
          } else {
            throw new Error('unknown error')
          }
        }
        /* jar controlled
        if (!r[0].headers['set-cookie']) {
          throw new Error('no set cookie')
        }*/

        const location = r.headers['location']
        const path = checkUrl(location)
        if (!path) {
          throw new Error('redirect hostname error')
        }

        // no need to update referer when redirect
        nextUrl = NET_TV_URL + path
      }
      break
    } catch (e) {
      if (e.message.includes('验证码错误') && i + 1 < maxRetries) {
        console.log('重试：' + e.message)
        continue
      }
      throw e
    }
  }

  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open logged homepage')
  }
  _url = nextUrl

  // ajax get messages
  nextUrl = NET_TV_URL + '/messageManageController.do?method=getMess'
  const r2 = await requestAsync(nextUrl, { method: 'POST', headers: { Referer: _url } })
  if (!r2) {
    throw new Error('failed to get ajax message num')
  }

  let m = r.data.match(/<a href="(.*?)"[^>]*?>违规节目<\/a>/i)
  if (!m) {
    throw new Error('failed to get illegal program link')
  }
  let nextUrl2 = checkUrl(m[1])
  if (!nextUrl2) {
    throw new Error('failed to match illegal program link')
  }
  m = r.data.match(/<a href="(.*?)"[^>]*?>最新公告<\/a>/i)
  let nextUrl3 = checkUrl(m[1])
  if (!nextUrl3) {
    throw new Error('failed to match manage news link')
  }

  nextUrl = NET_TV_URL + nextUrl2
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open illegal program frame')
  }
  m = r.data.match(/<table .*?>([\s\S]*?)<\/table>/i)
  if (!m) {
    throw new Error('failed to get illegal program table')
  }
  _url = nextUrl

  nextUrl = NET_TV_URL + '/programStoreController.do?method=listByArg&start=0&limit=50&keyWord=&isAll=keyWord&uploadDeptName=&startTime=&endTime=&programRroprety=&illegalReason=&programType=1&_dc=1618727117435&callback=stcCallback1001'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to list illegal program data')
  }
  const illegalPrograms = getRootItems('stcCallback1001', r.data)

  nextUrl = NET_TV_URL + nextUrl3
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open manage news frame')
  }
  _url = nextUrl

  nextUrl = NET_TV_URL + '/messageManageController.do?method=list&userId=698&start=0&limit=50&messageTitle=&messageType=&inceptObj=&startTime=&endTime=&_dc=1618727704960&callback=stcCallback1001'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to list illegal program data')
  }
  const manageNews = getRootItems('stcCallback1001', r.data)

  return {
    illegalPrograms,
    manageNews,
  }
}

main()
  .then((result) => {
    const d = new Date()
    const title = '登录成功 ' + formatDateTime(d)
    let subTitle = '违规节目：'
    console.log(title + '\n\n' + subTitle)
    let mailText = subTitle + '\n'
    let line = '序号 上传时间 节目名称 违规原因'
    console.log(line)
    mailText += line + '\n'
    result.illegalPrograms.forEach((item, i) => {
      line = `${i + 1} ${item.insertTime} ${trimHtml(item.programName)} ${trimHtml(item.auditIdea)}`
      console.log(line)
      mailText += line + '\n'
    })

    subTitle = '\n最新公告：'
    console.log(subTitle)
    mailText += subTitle + '\n'
    line = '序号 日期 标题'
    console.log(line)
    mailText += line + '\n'
    result.manageNews.forEach((item, i) => {
      line = `${i + 1} ${item.sendTime} ${trimHtml(item.messageTitle)}`
      console.log(line)
      mailText += line + '\n'
    })
    console.log('')
    sendMail(title, mailText)
  })
  .catch((err) => {
    console.log(err)
    const d = new Date()
    const title = '登录失败 ' + formatDateTime(d)
    sendMail(title, err.toString())
  })
  .catch(err => {
    console.log(err)
  })
