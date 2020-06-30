'use strict'

const path = require('path')
const url = require('url')
const axios = require('axios')
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
  return await client.get(uri, opts)
}

function checkUrl(_url) {
  const up = url.parse(_url)
  if (up.hostname && !NET_TV_URL.includes(up.hostname.toLowerCase())) {
    return null
  }
  return up.path
}

function trimHtml(content) {
  return content.replace(/<.*?>/g, '').trim()
}

function getIllegalProgramItems(tableHTML) {
  const m = tableHTML.match(/<tr.*?>([\s\S]*?)<\/tr>/ig)
  if (!m) {
    throw new Error('failed to list row')
  }
  const items = []
  for (const trHTML of m) {
    const mt = trHTML.match(/<(t[hd]).*?>([\s\S]*?)<\/\1>/ig)
    if (mt) {
      const s = mt.map(trimHtml)
      items.push(s)
    }
  }
  return items
}

function getManageNewsList(listHTML) {
  const m = listHTML.match(/<li.*?>([\s\S]*?)<\/li>/ig)
  if (!m) {
    throw new Error('failed to list row')
  }
  const items = []
  for (const liHTML of m) {
    const mt = liHTML.match(/<a\s.*?>([\s\S]*?)<\/a>([\s\S]*)<\/li>/i)
    if (mt) {
      const s = [ trimHtml(mt[2]), trimHtml(mt[1]) ]
      items.push(s)
    }
  }
  return items
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

async function main() {
  const account = config.account
  if (!account || !account['username'] || !account['password']) {
    throw new Error('config account error')
  }

  let _url = NET_TV_URL + '/'
  let r = await requestAsync(_url)
  if (!r || !r.data.includes('<frame src="main.jsp"')) {
    throw new Error('failed to open homepage')
  }

  let nextUrl = NET_TV_URL + '/right/loginForm.jsp'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data.includes('loginExcute.jsp"')) {
    throw new Error('failed to open login form')
  }

  _url = nextUrl
  nextUrl = NET_TV_URL + '/right/loginExcute.jsp'
  const qs = { pmail: account['username'], pcode: account['password'] }
  r = await requestAsync(nextUrl,
    { params: qs, maxRedirects: 0, headers: { Referer: _url }, validateStatus: function (status) {
        return status >= 200 && status < 400
      }, })
  if (r) {
    if (r.status !== 302) {
      const m = r.data.match(/<font color="red".*?>(.*?)<\/font>/i)
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

  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open logged homepage')
  }

  _url = nextUrl
  nextUrl = NET_TV_URL + '/top.jsp'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open logged top frame')
  }
  if (!r.data.includes('/personnel/MyInfoIndex.jsp"')) {
    throw new Error('failed to logged in')
  }
  let m = r.data.match(/<a href="(.*?)".*?>违规节目<\/a>/i)
  if (!m) {
    throw new Error('failed to get illegal program link')
  }
  let nextUrl2 = checkUrl(m[1])
  if (!nextUrl2) {
    throw new Error('failed to match illegal program link')
  }
  m = r.data.match(/<a href="(.*?)".*?>管理动态<\/a>/i)
  let nextUrl3 = checkUrl(m[1])
  if (!nextUrl3) {
    throw new Error('failed to match manage news link')
  }

  // REMOVE FOR SERVER INTERNAL ERROR AND NOT NECESSARY
  /*nextUrl = NET_TV_URL + '/main.jsp'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open logged main frame')
  }
  if (r.data.includes('/right/loginForm.jsp"')) {
    throw new Error('failed to logged in')
  }*/

  nextUrl = NET_TV_URL + nextUrl2
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open illegal program frame')
  }
  m = r.data.match(/<table .*?>([\s\S]*?)<\/table>/i)
  if (!m) {
    throw new Error('failed to get illegal program table')
  }
  const illegalPrograms = getIllegalProgramItems(m[1])

  nextUrl = NET_TV_URL + nextUrl3
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r.data) {
    throw new Error('failed to open manage news frame')
  }
  m = r.data.match(/<ul class="title_list">([\s\S]*?)<\/ul>/i)
  if (!m) {
    throw new Error('failed to get manage news list')
  }
  const manageNews = getManageNewsList(m[1])

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
    result.illegalPrograms.forEach(item => {
      console.log(item.join(','))
      mailText += item.join(' ') + '\n'
    })

    subTitle = '\n管理动态：'
    console.log(subTitle)
    mailText += subTitle + '\n'
    result.manageNews.forEach(item => {
      console.log(item.join(','))
      mailText += item.join(' ') + '\n'
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
