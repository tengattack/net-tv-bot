'use strict'

const url = require('url')
const request = require('request')
const nodemailer = require('nodemailer')
const config = require('./config')

const cookiesJar = request.jar()

const DEFAULT_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.79 Safari/537.36 Edge/14.14393'
const NET_TV_URL = 'http://net.tv.cn'

function requestAsync(uri, opts) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': config.userAgent || DEFAULT_USERAGENT
    }
    if (opts && opts.headers) {
      const _headers = Object.assign({ headers }, opts.headers)
      opts = Object.assign({
        uri,
        gzip: true,
        jar: cookiesJar,
      }, opts, { headers: _headers })
    } else {
      opts = Object.assign({
        uri,
        headers,
        gzip: true,
        jar: cookiesJar,
      }, opts)
    }
    request(opts, function (err, resp, body) {
      if (err) {
        reject(err)
        return
      }
      resolve([ resp, body ])
    })
  })
}

function checkUrl(_url) {
  const up = url.parse(_url)
  if (up.hostname && !NET_TV_URL.includes(up.hostname.toLowerCase())) {
    return null
  }
  return up.path
}

function getTableItem(tableHTML) {
  const m = tableHTML.match(/<tr.*?>([\s\S]*?)<\/tr>/ig)
  if (!m) {
    throw new Error('failed to list row')
  }
  const items = []
  for (const trHTML of m) {
    const mt = trHTML.match(/<(t[hd]).*?>([\s\S]*?)<\/\1>/ig)
    if (mt) {
      const s = mt.map(content => content.replace(/<.*?>/g, '').trim())
      items.push(s)
    }
  }
  return items
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
    if (error) {
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
  if (!r || !r[1].includes('<frame src="main.jsp"')) {
    throw new Error('failed to open homepage')
  }

  let nextUrl = NET_TV_URL + '/right/loginForm.jsp'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r[1].includes('loginExcute.jsp"')) {
    throw new Error('failed to open login form')
  }

  _url = nextUrl
  nextUrl = NET_TV_URL + '/right/loginExcute.jsp'
  const qs = { pmail: account['username'], pcode: account['password'] }
  r = await requestAsync(nextUrl,
    { qs, useQuerystring: true, followRedirect: false, headers: { Referer: _url } })
  if (r) {
    if (r[0].statusCode !== 302) {
      const m = r[1].match(/<font color="red".*?>(.*?)<\/font>/i)
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

    const location = r[0].headers['location']
    const path = checkUrl(location)
    if (!path) {
      throw new Error('redirect hostname error')
    }

    // no need to update referer when redirect
    nextUrl = NET_TV_URL + path
  }

  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r[1]) {
    throw new Error('failed to open logged homepage')
  }

  _url = nextUrl
  nextUrl = NET_TV_URL + '/top.jsp'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r[1]) {
    throw new Error('failed to open logged top frame')
  }
  if (!r[1].includes('/personnel/MyInfoIndex.jsp"')) {
    throw new Error('failed to logged in')
  }
  let m = r[1].match(/<a href="(.*?)".*?>违规节目<\/a>/i)
  if (!m) {
    throw new Error('failed to get illegal program link')
  }
  let nextUrl2 = checkUrl(m[1])
  if (!nextUrl2) {
    throw new Error('failed to match illegal program link')
  }

  nextUrl = NET_TV_URL + '/main.jsp'
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r[1]) {
    throw new Error('failed to open logged main frame')
  }
  if (r[1].includes('/right/loginForm.jsp"')) {
    throw new Error('failed to logged in')
  }

  nextUrl = NET_TV_URL + nextUrl2
  r = await requestAsync(nextUrl, { headers: { Referer: _url } })
  if (!r || !r[1]) {
    throw new Error('failed to open illegal program frame')
  }
  m = r[1].match(/<table .*?>([\s\S]*?)<\/table>/i)
  if (!m) {
    throw new Error('failed to get illegal program table')
  }

  return getTableItem(m[1])
}

main()
  .then(items => {
    const d = new Date()
    const title = '登录成功 ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
    console.log(title)
    let mailText = ''
    items.forEach(item => {
      console.log(item.join(','))
      mailText += item.join(' ') + '\n'
    })
    console.log('')
    sendMail(title, mailText)
  })
  .catch(err => {
    console.log(err)
    const d = new Date()
    const title = '登录失败 ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString()
    sendMail(title, err.toString())
  })
  .catch(err => {
    console.log(err)
  })
