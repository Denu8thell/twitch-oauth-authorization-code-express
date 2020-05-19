import * as https from "https";
import * as crypto from "crypto";
import {Application} from "express";
import {URL} from "url";

type TwitchAccessTokenResponse = {
    access_token: string,
    refresh_token: string,
    expires_in: number,
    scope: string[],
    token_type: string
}

type TwitchRefreshTokenResponse = {
    access_token: string,
    refresh_token: string,
    expires_in: number,
    scope: string,
    token_type: string
}

type TokenInfo = {
    access_token: string,
    refresh_token: string,
    expiry_date: Date,
    scopes: string[]
}

type OAuthTokenCallback = (req: any, res: any, info: TokenInfo) => void;

// app is the express application, redirect_uri is the specified witch API redirect_uri
// landing_path is the final path that the API redirects.
// scopes is a list of strings, identifying the requested scopes.
type TwitchOAuthPathOptions = {
    app: Application, // Express application to add path to
    callback: OAuthTokenCallback, // Callback when a valid token is received
    redirect_uri: string, //URI twitch will redirect to with OAUTH code
    scopes?: string[], //list of scopes you are requesting
    client_id: string, //Registered client id
    client_secret: string, // Registered client secret
    force_verify?: boolean, // If true, user will always be prompted to confirm authorization.
    token_url?: string, // url to send the code to to get the actual token, if non-standard (e.g. testing)
    authorize_url?: string // url to send the client towards in order to get them to authorize your app. Useful for testing
};

// Assumes that the express application has the session middleware installed
function setupTwitchOAuthPath(options: TwitchOAuthPathOptions) {

    options.token_url = options.token_url || `https://id.twitch.tv/oauth2/token`;
    options.authorize_url = options.authorize_url || `https://id.twitch.tv/oauth2/authorize`;

    let redirect_uri_obj = new URL(options.redirect_uri);
    options.app.get(redirect_uri_obj.pathname, function (req, res) {
        if(!req.session){
            throw Error('No session middleware detected; Please attach session middleware!');
        }

        if (req.query && req.query.code) {
            //Have code, make request with
            //Also assert state token is OK
            if (!req.query.state || req.query.state !== req.session.oauth_state) {
                //TODO better error handling?
                res.end('Invalid state token returned from twitch.');
                return;
            }

            let https_request = https.request(options.token_url +
                `?client_id=${options.client_id}` +
                `&client_secret=${options.client_secret}` +
                `&code=${req.query.code}` +
                `&grant_type=authorization_code` +
                `&redirect_uri=${encodeURIComponent(options.redirect_uri)}`,
                {
                    method: 'POST'
                },
                (https_res) => {
                    let rawData = '';
                    https_res.on('data', (chunk) => {
                        rawData += chunk;
                    });

                    https_res.on('end', () => {
                        let data: TwitchAccessTokenResponse = JSON.parse(rawData);
                        let info: TokenInfo = {
                            access_token: data.access_token,
                            refresh_token: data.refresh_token,
                            scopes: data.scope,
                            expiry_date: new Date(Date.now() + data.expires_in * 1000)
                        };
                        options.callback(req, res, info);
                    });
                }
            );

            https_request.on("error", (e) => {
                //TODO better error handling?
                res.send('Got error');
                res.end(e);
            });

            https_request.end();
        } else {
            // RFC 6749 suggests using a hash of the session cookie. Here, we use a random 16 bytes instead.
            // This may be more computationally expensive -
            //TODO see if there are benefits to switching to hashing session cookie instead
            req.session.oauth_state = crypto.randomBytes(16).toString('hex');

            let scope_string: string = options.scopes ? options.scopes.join(' ') : '';

            res.redirect(307, options.authorize_url +
                `?client_id=${options.client_id}` +
                `&redirect_uri=${encodeURIComponent(options.redirect_uri)}` +
                `&response_type=code` +
                `&scope=${encodeURIComponent(scope_string)}` +
                `&state=${req.session.oauth_state}` +
                (options.force_verify ? `&force_verify=${options.force_verify}` : ''));
        }
    });
}

// Refresh token OAuth token - it is up to the user of this library to properly synchronize this
async function refreshToken(refresh_token: string, client_id: string, client_secret: string, scopes?: string[], token_url?: string) : Promise<TokenInfo>{
    return new Promise((resolve, reject) => {
        let scope_string: string | undefined = scopes ? scopes.join(' ') : undefined;

        let https_request = https.request((token_url ? token_url : `https://id.twitch.tv/oauth2/token`) +
            `?refresh_token=${refresh_token}` +
            `&client_id=${client_id}` +
            `&client_secret=${client_secret}` +
            `&grant_type=refresh_token` +
            (scope_string ? `&scope=${encodeURIComponent(scope_string)}` : ''),
            {
                method: 'POST',
                timeout: 10000
            },
            (https_res) => {
                let rawData = '';

                https_res.on('data', (chunk) => {
                    rawData += chunk;
                });

                https_res.on('end', () => {
                    if(!https_res.statusCode){
                        return reject(new Error('No statusCode on response?!?!?!'));
                    }

                    if(Math.floor(https_res.statusCode / 100) != 2){
                        //Not a 2xx status code; Meaning this is an error.
                        return reject(JSON.parse(rawData));
                    }

                    let data: TwitchRefreshTokenResponse = JSON.parse(rawData);
                    let scopes: string[] = data.scope.trim() === '' ? [] : data.scope.split(' ');
                    let info: TokenInfo = {
                        access_token: data.access_token,
                        refresh_token: data.refresh_token,
                        scopes: scopes,
                        expiry_date: new Date(Date.now() + data.expires_in * 1000)
                    };
                    resolve(info);
                });
            }
        );

        https_request.on("error", (e) => {
            reject(e);
        });

        https_request.end();
    });
}

export {
    setupTwitchOAuthPath,
    refreshToken,
    TokenInfo
}