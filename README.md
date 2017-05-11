# net-tv-bot

A bot for fetching information from net.tv.cn

## Setup

```shell
npm i
cp config.example.js config.js
# Edit with your username & password
vi config.js
```

## Crontab

Logging every day automatically.

```shell
crontab -e
# add '35 9 * * * /path/to/node `pwd`/index.js'
```

## License

MIT
