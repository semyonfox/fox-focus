pipeline {
  agent { label 'docker-agent' }
  triggers {
    githubPush()
    pollSCM('H/10 * * * *')
  }
  options {
    skipDefaultCheckout(true)
    disableConcurrentBuilds()
    timestamps()
    timeout(time: 15, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '15'))
  }
  stages {
    stage('Checkout source') {
      steps {
        dir('source') {
          deleteDir()
          checkout scm
        }
      }
    }
    stage('Build and test') {
      steps {
        dir('source') {
          sh '''
            set -eu
            commit="$(git rev-parse --verify HEAD)"
            image="fox-focus-app:commit-$commit"
            printf '%s\n' "$commit" > "$WORKSPACE/.fox-focus-commit"
            printf '%s\n' "$image" > "$WORKSPACE/.fox-focus-image"
            docker build \
              --label app=fox-focus \
              --label jenkins-build="$BUILD_NUMBER" \
              --label org.opencontainers.image.revision="$commit" \
              -t "$image" \
              .
            [ "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$commit" ]
          '''
        }
      }
    }
    stage('Isolated candidate') {
      steps {
        sh '''
          set -eu
          source_dir="$WORKSPACE/source"
          oauth_env=/home/semyon/server-stacks/jenkins/fox-focus/oauth.env
          [ -f "$oauth_env" ]
          set -a
          . "$oauth_env"
          set +a
          : "${APP_BASE_URL:?APP_BASE_URL is required}"
          image="$(cat "$WORKSPACE/.fox-focus-image")"
          google_client="${GOOGLE_OAUTH_CLIENT_FILE_HOST:?GOOGLE_OAUTH_CLIENT_FILE_HOST is required}"
          microsoft_client="${MICROSOFT_OAUTH_CLIENT_FILE_HOST:-$source_dir/empty-oauth/microsoft-client.placeholder}"
          token_key="${OAUTH_TOKEN_KEY_FILE_HOST:?OAUTH_TOKEN_KEY_FILE_HOST is required}"
          candidate="fox-focus-candidate-$BUILD_NUMBER"
          trap 'docker rm -f "$candidate" >/dev/null 2>&1 || true' EXIT
          docker run -d --rm --name "$candidate" --network none \\
            -e APP_BASE_URL \\
            -e GOOGLE_OAUTH_CLIENT_FILE=/run/secrets/fox-focus/google-client.json \\
            -e MICROSOFT_OAUTH_CLIENT_FILE=/run/secrets/fox-focus/microsoft-client.json \\
            -e OAUTH_TOKEN_KEY_FILE=/run/secrets/fox-focus/token-key \\
            -v "$google_client":/run/secrets/fox-focus/google-client.json:ro \\
            -v "$microsoft_client":/run/secrets/fox-focus/microsoft-client.json:ro \\
            -v "$token_key":/run/secrets/fox-focus/token-key:ro \\
            "$image"
          healthy=false
          for attempt in $(seq 1 20); do
            if docker exec "$candidate" node -e "fetch('http://127.0.0.1:8789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=true; break; fi
            sleep 2
          done
          [ "$healthy" = true ]
          docker exec "$candidate" node -e "Promise.all(['/', '/app', '/api/v1/workspace', '/api/v1/hermes', '/api/v1/integrations'].map(p=>fetch('http://127.0.0.1:8789'+p).then(r=>r.status))).then(s=>{if(s.join(',')!=='401,401,401,401,401')process.exit(1)})"
          docker exec "$candidate" node --input-type=module -e "import { readFileSync } from 'node:fs'; try { const password=readFileSync('/data/workspace-password','utf8').trim(); const authorization='Basic '+Buffer.from('fox:'+password).toString('base64'); const response=await fetch('http://127.0.0.1:8789/api/v1/integrations',{headers:{authorization}}); const overview=await response.json(); const google=overview.providers?.find(provider=>provider.provider==='google'); process.exit(response.ok&&google?.configured===true?0:1); } catch { process.exit(1); }"
        '''
      }
    }
    stage('Deploy and verify') {
      steps {
        dir('source') {
          sh '''
            set -eu
            image="$(cat "$WORKSPACE/.fox-focus-image")"
            commit="$(cat "$WORKSPACE/.fox-focus-commit")"
            env_file=/home/semyon/server-stacks/jenkins/fox-focus/.env
            oauth_env=/home/semyon/server-stacks/jenkins/fox-focus/oauth.env
            deploy_compose=/home/semyon/server-stacks/jenkins/fox-focus/compose.yaml
            [ -f "$oauth_env" ]
            [ "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$commit" ]

            data_volume_before="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
            data_rw_before="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.RW}}{{end}}{{end}}')"
            hermes_source_before="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/hermes/personal-tasks"}}{{.Source}}{{end}}{{end}}')"
            hermes_rw_before="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/hermes/personal-tasks"}}{{.RW}}{{end}}{{end}}')"
            [ -n "$data_volume_before" ]
            [ "$data_rw_before" = true ]
            [ -n "$hermes_source_before" ]
            [ "$hermes_rw_before" = false ]
            previous="$(docker inspect fox-focus-app-1 --format '{{.Image}}')"
            docker tag "$previous" "fox-focus-app:rollback-$BUILD_NUMBER"

            assert_mounts() {
              data_volume_after="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
              data_rw_after="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.RW}}{{end}}{{end}}')"
              hermes_source_after="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/hermes/personal-tasks"}}{{.Source}}{{end}}{{end}}')"
              hermes_rw_after="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "/hermes/personal-tasks"}}{{.RW}}{{end}}{{end}}')"
              [ "$data_volume_after" = "$data_volume_before" ] || return 1
              [ "$data_rw_after" = "$data_rw_before" ] || return 1
              [ "$hermes_source_after" = "$hermes_source_before" ] || return 1
              [ "$hermes_rw_after" = "$hermes_rw_before" ] || return 1
              for target in /run/secrets/fox-focus/google-client.json /run/secrets/fox-focus/microsoft-client.json /run/secrets/fox-focus/token-key; do
                oauth_read_only_after="$(docker inspect fox-focus-app-1 --format '{{range .Mounts}}{{if eq .Destination "'"$target"'"}}{{.RW}}{{end}}{{end}}')"
                [ "$oauth_read_only_after" = false ] || return 1
              done
            }
            assert_runtime() {
              healthy=false
              for attempt in $(seq 1 30); do
                if [ "$(docker inspect fox-focus-app-1 --format '{{.State.Health.Status}}')" = healthy ]; then healthy=true; break; fi
                sleep 3
              done
              [ "$healthy" = true ] || return 1
              docker run --rm --network host --entrypoint node "$image" -e "fetch('http://127.0.0.1:8789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || return 1
              curl --fail --silent --show-error https://focus.semyon.ie/healthz || return 1
              for path in / /app /api/v1/workspace /api/v1/hermes /api/v1/integrations; do
                http_status=$(curl --silent --output /dev/null --write-out '%{http_code}' "https://focus.semyon.ie$path") || return 1
                [ "$http_status" = 401 ] || return 1
              done
            }
            assert_integration_runtime() {
              docker exec fox-focus-app-1 node --input-type=module -e "import { readFileSync } from 'node:fs'; try { const password=readFileSync('/data/workspace-password','utf8').trim(); const authorization='Basic '+Buffer.from('fox:'+password).toString('base64'); const response=await fetch('http://127.0.0.1:8789/api/v1/integrations',{headers:{authorization}}); const overview=await response.json(); const google=overview.providers?.find(provider=>provider.provider==='google'); process.exit(response.ok&&google?.configured===true?0:1); } catch { process.exit(1); }"
            }
            rollback() {
              FOX_FOCUS_IMAGE="fox-focus-app:rollback-$BUILD_NUMBER" docker compose -f "$deploy_compose" --env-file "$env_file" --env-file "$oauth_env" -p fox-focus up -d --no-build --no-deps app || return 1
              assert_runtime || return 1
              assert_mounts || return 1
            }
            failure() {
              failure_code=$?
              trap - EXIT
              if ! rollback; then
                echo 'Rollback verification failed; manual intervention is required.' >&2
              fi
              exit "$failure_code"
            }

            FOX_FOCUS_IMAGE="$image" docker compose -f "$deploy_compose" --env-file "$env_file" --env-file "$oauth_env" -p fox-focus config -q
            FOX_FOCUS_IMAGE="$image" docker compose -f "$deploy_compose" --env-file "$env_file" --env-file "$oauth_env" -p fox-focus config --format json | FOX_FOCUS_DATA_VOLUME="$data_volume_before" FOX_FOCUS_HERMES_SOURCE="$hermes_source_before" node --input-type=module -e '
              let config = "";
              process.stdin.setEncoding("utf8");
              process.stdin.on("data", chunk => { config += chunk; });
              process.stdin.on("end", () => {
                const parsed = JSON.parse(config);
                const mounts = parsed.services?.app?.volumes ?? [];
                const data = mounts.find(mount => mount.target === "/data");
                const hermes = mounts.find(mount => mount.target === "/hermes/personal-tasks");
                const oauthTargets = ["/run/secrets/fox-focus/google-client.json", "/run/secrets/fox-focus/microsoft-client.json", "/run/secrets/fox-focus/token-key"];
                const dataVolume = data && (parsed.volumes?.[data.source]?.name ?? data.source);
                if (!data || data.type !== "volume" || dataVolume !== process.env.FOX_FOCUS_DATA_VOLUME || data.read_only === true) throw new Error("Deployment config changes the /data mount");
                if (!hermes || hermes.type !== "bind" || hermes.source !== process.env.FOX_FOCUS_HERMES_SOURCE || hermes.read_only !== true) throw new Error("Deployment config changes the Hermes mount");
                if (!oauthTargets.every(target => mounts.some(mount => mount.target === target && mount.type === "bind" && mount.read_only === true))) throw new Error("Deployment config does not mount OAuth credentials read-only");
              });
            '

            trap failure EXIT
            FOX_FOCUS_IMAGE="$image" docker compose -f "$deploy_compose" --env-file "$env_file" --env-file "$oauth_env" -p fox-focus up -d --no-build --no-deps app
            assert_runtime
            assert_mounts
            assert_integration_runtime
            trap - EXIT
          '''
        }
      }
    }
  }
}
