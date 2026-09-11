pipeline {
  agent { label 'docker-agent' }
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
            docker build --label app=fox-focus --label jenkins-build="$BUILD_NUMBER" -t "fox-focus-app:jenkins-$BUILD_NUMBER" .
          '''
        }
      }
    }
    stage('Isolated candidate') {
      steps {
        sh '''
          set -eu
          candidate="fox-focus-candidate-$BUILD_NUMBER"
          trap 'docker rm -f "$candidate" >/dev/null 2>&1 || true' EXIT
          docker run -d --name "$candidate" --network none "fox-focus-app:jenkins-$BUILD_NUMBER"
          for attempt in $(seq 1 20); do
            if docker exec "$candidate" node -e "fetch('http://127.0.0.1:8789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
            sleep 2
          done
          docker exec "$candidate" node -e "Promise.all(['/', '/app', '/api/v1/hermes'].map(p=>fetch('http://127.0.0.1:8789'+p).then(r=>r.status))).then(s=>{if(s.join(',')!=='401,401,401')process.exit(1)})"
        '''
      }
    }
    stage('Deploy and verify') {
      steps {
        dir('source') {
          sh '''
            set -eu
            previous=$(docker inspect fox-focus-app-1 --format '{{.Image}}')
            docker tag "$previous" "fox-focus-app:rollback-$BUILD_NUMBER"
            rollback() {
              FOX_FOCUS_IMAGE="fox-focus-app:rollback-$BUILD_NUMBER" docker compose --env-file /home/semyon/server-stacks/jenkins/fox-focus/.env -p fox-focus up -d --no-build --no-deps app
            }
            trap 'rollback' EXIT
            export FOX_FOCUS_IMAGE="fox-focus-app:jenkins-$BUILD_NUMBER"
            docker compose --env-file /home/semyon/server-stacks/jenkins/fox-focus/.env -p fox-focus up -d --no-build --no-deps app
            healthy=false
            for attempt in $(seq 1 30); do
              if [ "$(docker inspect fox-focus-app-1 --format '{{.State.Health.Status}}')" = healthy ]; then healthy=true; break; fi
              sleep 3
            done
            [ "$healthy" = true ]
            curl --fail --silent --show-error https://focus.semyon.ie/healthz
            [ "$(curl --silent --output /dev/null --write-out '%{http_code}' https://focus.semyon.ie/)" = 401 ]
            [ "$(curl --silent --output /dev/null --write-out '%{http_code}' https://focus.semyon.ie/api/v1/hermes)" = 401 ]
            trap - EXIT
          '''
        }
      }
    }
  }
}
