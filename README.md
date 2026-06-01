# f0ckm

## prod

first things

`cp .env.example .env`

fill with for example: f0ckm

`cp config_example.json config.json`

Edit to needs, for sql you can do this:

host can either be localhost or the docker containers hostname, when running via docker this must be the dockers hostname

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

Create admin user in dev env

`DB_HOST=localhost DB_PORT=5454 node scripts/create-admin.mjs admin 'YOUR_PASSWORD_HERE'`

now visit http://localhost:1337 in your browser, you can develop without needing to rebuild the docker image for every change
