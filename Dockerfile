ARG MATTERBRIDGE_BASE_IMAGE=luligu/matterbridge:3.11.5
FROM ${MATTERBRIDGE_BASE_IMAGE} AS native-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev && rm -rf /var/lib/apt/lists/*
COPY native/evdev.c /tmp/evdev.c
RUN cc -shared -fPIC -Wall -Wextra -Werror -I/usr/local/include/node /tmp/evdev.c -o /tmp/evdev.node

FROM ${MATTERBRIDGE_BASE_IMAGE}
COPY package.json index.js store.js credentials.js engine.js input.js actions.js content.js /usr/local/lib/node_modules/matterbridge-securitysystem-keypad/
COPY --from=native-build /tmp/evdev.node /usr/local/lib/node_modules/matterbridge-securitysystem-keypad/native/evdev.node
COPY apps/frontend/build/ /usr/local/lib/node_modules/matterbridge-securitysystem-keypad/apps/frontend/build/
COPY docker-start.sh /usr/local/bin/matterbridge-securitysystem-keypad-start
CMD ["/bin/sh", "/usr/local/bin/matterbridge-securitysystem-keypad-start"]
