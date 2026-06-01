# f0ckm

Happy to finally bring you f0ckm! The long awaited imageboard solution that you can host yourself. It is designed to be a real alternative to big tech platforms that you can modify to suit your communities needs.

It features extensive tagging, searching, filtering and a variety of options.

The software is mostly generic, it can be modified easily via config.json to suit your communities needs. Most things can be enabled/disabled very easily and modified to needs.

The software comes without any warranties or entitlements of any kind! The developer is not responsible for anything you do with the use of this software.

## Software Requirements

- Docker (https://docs.docker.com/engine/install/debian/)

## prod

first things

`cp .env.example .env`

fill with for example: f0ckm (prefilled)

`cp config_example.json config.json`

Edit to needs, for sql you can do this:

host can either be localhost or the docker containers hostname, when running via docker this must be the dockers hostname, if you choose localhost you wont need to add the ENV `DB_HOST=localhost` and if you also change the port to be `DB_PORT=5454` you wont need this ENV either, but then Docker wont find the DB.

```
"sql": {
  "host": "f0ckm-db",
  "port": 5432,
  "user": "f0ckm",
  "password": "f0ckm",
  "database": "f0ckm",
  "multipleStatements": true,
  "max": 50
},
```

`docker compose up -d`

`docker exec -i f0ckm-db psql -U f0ckm -d f0ckm < migrations/f0ckm_schema.sql`

`docker exec -t f0ckm node scripts/seed.mjs`

`docker exec -t f0ckm node scripts/create-admin.mjs admin 'YOUR_PASSWORD_HERE'`

For regular building after making changes to the source code

`bash build.bash master`

now vist http://localhost:1337 in your browser

## dev

NOTE: when developing locally it might be necessary to run commands with `DB_HOST=localhost DB_PORT=5454`

`docker compose up -d f0ckm-db`

on dev machine:

`npm i`
`npm run dev`

Fill Database

`docker exec -i f0ckm-db psql -U f0ckm -d f0ckm < migrations/f0ckm_schema.sql`

`DB_HOST=localhost DB_PORT=5454 node scripts/seed.mjs`

Create admin user in dev env

`DB_HOST=localhost DB_PORT=5454 node scripts/create-admin.mjs admin 'YOUR_PASSWORD_HERE'`

now visit http://localhost:1337 in your browser, you can develop without needing to rebuild the docker image for every change

## NGINX

uncomment in .env # COMPOSE_PROFILES=f0ckm-nginx to enable nginx proxy with automatic lets encrypt.
