import * as passport from 'passport';
import { OAuth2Strategy as Strategy } from 'passport-google-oauth';
import * as passwordless from 'passwordless';

import sendEmail from './aws-ses';
import logger from './logs';
import getEmailTemplate from './models/EmailTemplate';
import Invitation from './models/Invitation';
import User, { IUserDocument } from './models/User';
import PasswordlessMongoStore from './passwordless';

const dev = process.env.NODE_ENV !== 'production';
const { PRODUCTION_URL_APP } = process.env;
const URL_APP = dev ? 'http://localhost:3000' : PRODUCTION_URL_APP;

function setupPasswordless({ server, ROOT_URL }) {
  passwordless.init(new PasswordlessMongoStore());

  passwordless.addDelivery(async (tokenToSend, uidToSend, recipient, callback) => {
    try {
      const template = await getEmailTemplate('login', {
        loginURL: `${ROOT_URL}/auth/logged_in?token=${tokenToSend}&uid=${encodeURIComponent(
          uidToSend,
        )}`,
      });

      await sendEmail({
        from: `Kelly from async-await.com <${process.env.EMAIL_SUPPORT_FROM_ADDRESS}>`,
        to: [recipient],
        subject: template.subject,
        body: template.message,
      });

      callback();
    } catch (err) {
      logger.error('Email sending error:', err);
      callback(err);
    }
  });

  server.use(passwordless.sessionSupport());
  server.use(passwordless.acceptToken({ successRedirect: URL_APP }));

  server.use((req, __, next) => {
    if (req.user && typeof req.user === 'string') {
      User.findById(req.user, User.publicFields(), (err, user) => {
        req.user = user;
        next(err);
      });
    } else {
      next();
    }
  });

  server.post(
    '/auth/send-token',
    passwordless.requestToken(
      async (email, __, callback) => {
        try {
          const user = await User.findOne({ email })
            .select('_id')
            .setOptions({ lean: true });

          if (user) {
            callback(null, user._id);
          } else {
            callback(null, null);
          }
        } catch (error) {
          callback(error);
        }
      },
      { userField: 'email' },
    ),
    (__, res) => {
      res.json({ done: 1 });
    },
  );

  server.get('/logout', passwordless.logout(), (req, res) => {
    req.logout();
    res.redirect(`${URL_APP}/login`);
  });
}

function setupGoogle({ ROOT_URL, server }) {
  const clientID = process.env.Google_clientID;
  const clientSecret = process.env.Google_clientSecret;

  const verify = async (accessToken, refreshToken, profile, verified) => {
    let email;
    let avatarUrl;

    if (profile.emails) {
      email = profile.emails[0].value;
    }

    if (profile.photos && profile.photos.length > 0) {
      avatarUrl = profile.photos[0].value.replace('sz=50', 'sz=128');
    }

    try {
      const user = await User.signInOrSignUp({
        googleId: profile.id,
        email,
        googleToken: { accessToken, refreshToken },
        displayName: profile.displayName,
        avatarUrl,
      });

      verified(null, user);
    } catch (err) {
      verified(err);
      logger.error(err); // eslint-disable-line
    }
  };

  passport.use(
    new Strategy(
      {
        clientID,
        clientSecret,
        callbackURL: `${ROOT_URL}/oauth2callback`,
      },
      verify,
    ),
  );

  passport.serializeUser((user: IUserDocument, done) => {
    done(null, user._id);
  });

  passport.deserializeUser((id, done) => {
    User.findById(id, User.publicFields(), (err, user) => {
      done(err, user);
    });
  });

  server.use(passport.initialize());
  server.use(passport.session());

  server.get('/auth/google', (req, res, next) => {
    const options = {
      scope: ['profile', 'email'],
      prompt: 'select_account',
    };

    if (req.query && req.query.next && req.query.next.startsWith('/')) {
      req.session.next_url = req.query.next;
    } else {
      req.session.next_url = null;
    }

    if (req.query && req.query.invitationToken) {
      req.session.invitationToken = req.query.invitationToken;
    } else {
      req.session.invitationToken = null;
    }

    passport.authenticate('google', options)(req, res, next);
  });

  server.get(
    '/oauth2callback',
    passport.authenticate('google', {
      failureRedirect: '/login',
    }),
    (req, res) => {
      if (req.user && req.session.invitationToken) {
        Invitation.addUserToTeam({ token: req.session.invitationToken, user: req.user }).catch(
          err => logger.error(err),
        );
      }

      let redirectUrlAfterLogin;

      if (req.user && req.session.next_url) {
        redirectUrlAfterLogin = req.session.next_url;
      } else {
        if (!req.user.defaultTeamSlug) {
          redirectUrlAfterLogin = '/create-team';
        } else {
          redirectUrlAfterLogin = `/team/${req.user.defaultTeamSlug}/discussions`;
        }
      }

      res.redirect(`${URL_APP}${redirectUrlAfterLogin}`);
    },
  );
}

export { setupPasswordless, setupGoogle };
