import { CommonPayload, EmitterWebhookEventName, EventFilter, EventHandler } from './events'
import { Method } from 'axios'
import { Context, Dict, Logger, Quester, Schema, segment, Service, Session, Time } from 'koishi'
import {} from '@koishijs/assets'
import {} from 'koishi-plugin-puppeteer'
import { INDICATOR } from './markdown'

declare module 'koishi' {
  interface Context {
    github?: GitHub
  }

  interface Events {
    'github/webhook'(event: string, payload: CommonPayload): void
  }

  interface User {
    github: {
      accessToken: string
      refreshToken: string
    }
  }

  interface Channel {
    github: {
      webhooks: Dict<EventFilter>
    }
  }

  interface Tables {
    github: Repository
  }
}

interface Repository {
  name: string
  secret: string
  id: number
}

export interface Config {
  path?: string
  appId?: string
  appSecret?: string
  messagePrefix?: string
  replyFooter?: string
  redirect?: string
  replyTimeout?: number
  requestTimeout?: number
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().description('GitHub 服务的路径。').default('/github'),
  appId: Schema.string().description('GitHub OAuth App ID.'),
  appSecret: Schema.string().description('GitHub OAuth App Secret.'),
  redirect: Schema.string().description('授权成功后的跳转链接。'),
  messagePrefix: Schema.string().description('推送消息的前缀。').default('[GitHub] '),
  replyFooter: Schema.string().description('显示在回复消息尾部的固定文字。').role('textarea').default([
    '---',
    'Generated by [koishi-plugin-github](https://github.koishi.chat/).',
  ].join('\n')),
  replyTimeout: Schema.natural().role('ms').description('等待用户回复消息进行快捷操作的时间。').default(Time.hour),
  requestTimeout: Schema.natural().role('ms').description('等待请求 GitHub 的时间，超时将提示操作失败。缺省时会使用全局设置。'),
})

export interface OAuth {
  access_token: string
  expires_in: string
  refresh_token: string
  refresh_token_expires_in: string
  token_type: string
  scope: string
}

export type ReplySession = Session<'github'>

const logger = new Logger('github')

export class GitHub extends Service {
  private http: Quester
  public history: Dict<ReplyPayloads> = Object.create(null)

  constructor(public ctx: Context, public config: Config) {
    super(ctx, 'github', true)

    this.http = ctx.http.extend({})

    ctx.model.extend('user', {
      'github.accessToken': 'string(50)',
      'github.refreshToken': 'string(50)',
    })

    ctx.model.extend('channel', {
      'github.webhooks': 'json',
    })

    ctx.model.extend('github', {
      id: 'integer',
      name: 'string(50)',
      secret: 'string(50)',
    })
  }

  async emit<T extends EmitterWebhookEventName, P = {}>(event: T, payload: CommonPayload) {
    let result: any
    if (payload.action) {
      result = await this.ctx.serial(`github/event/${event}/${payload.action}` as any, payload)
    }
    if (!result) {
      result = await this.ctx.serial(`github/event/${event}` as any, payload)
    }
    return result as EventData<P>
  }

  on<T extends EmitterWebhookEventName>(event: T, listener: EventHandler<T>, prepend = false) {
    return this.ctx.on('github/event/' + event as any, listener, prepend)
  }

  async getTokens(params: any) {
    return this.http.post<OAuth>('https://github.com/login/oauth/access_token', {}, {
      params: {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        ...params,
      },
      headers: { Accept: 'application/json' },
      timeout: this.config.requestTimeout,
    })
  }

  private async _request(method: Method, url: string, session: ReplySession, data?: any, headers?: Dict) {
    logger.debug(method, url, data)
    return this.http(method, url, {
      data,
      headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `token ${session.user.github.accessToken}`,
        ...headers,
      },
      timeout: this.config.requestTimeout,
    })
  }

  async authorize(session: Session, message: string) {
    await session.send(message)
    await session.execute({ name: 'github.authorize' })
  }

  async request(method: Method, url: string, session: ReplySession, body?: any, headers?: Dict) {
    if (!session.user.github.accessToken) {
      return this.authorize(session, session.text('github.require-auth'))
    }

    try {
      return await this._request(method, url, session, body, headers)
    } catch (error) {
      if (!Quester.isAxiosError(error) || error.response?.status !== 401) throw error
    }

    try {
      const data = await this.getTokens({
        refresh_token: session.user.github.refreshToken,
        grant_type: 'refresh_token',
      })
      session.user.github.accessToken = data.access_token
      session.user.github.refreshToken = data.refresh_token
    } catch {
      return this.authorize(session, session.text('github.auth-expired'))
    }

    return await this._request(method, url, session, body, headers)
  }
}

export type ReplyPayloads = {
  [K in keyof ReplyHandler]?: ReplyHandler[K] extends (...args: infer P) => any ? P : never
}

export type EventData<T = {}> = [string, (ReplyPayloads & T)?]

export class ReplyHandler {
  constructor(public github: GitHub, public session: ReplySession, public content?: string) {}

  async request(method: Method, url: string, message: string, body?: any, headers?: Dict) {
    try {
      await this.github.request(method, url, this.session, body, headers)
    } catch (err) {
      if (!Quester.isAxiosError(err)) throw err
      logger.warn(err)
      return message
    }
  }

  link(url: string) {
    return url
  }

  react(url: string) {
    return this.request('POST', url, this.session.text('github.send-failed'), {
      content: this.content,
    }, {
      accept: 'application/vnd.github.squirrel-girl-preview',
    })
  }

  async transform(source: string) {
    if (this.github.ctx.assets) {
      source = await this.github.ctx.assets.transform(source)
    }
    return [
      segment.transform(source, {
        text: ({ content }) => content,
        image: ({ url }) => `![image](${url})`,
        default: false,
      }),
      INDICATOR,
      this.github.config.replyFooter,
    ].join('\n')
  }

  async reply(url: string, params?: Dict) {
    return this.request('POST', url, this.session.text('github.send-failed'), {
      body: await this.transform(this.content),
      ...params,
    })
  }

  base(url: string) {
    return this.request('PATCH', url, this.session.text('github.modify-failed'), {
      base: this.content,
    })
  }

  merge(url: string, method?: 'merge' | 'squash' | 'rebase') {
    const [title] = this.content.split('\n', 1)
    const message = this.content.slice(title.length)
    return this.request('PUT', url, this.session.text('github.action-failed'), {
      merge_method: method,
      commit_title: title.trim(),
      commit_message: message.trim(),
    })
  }

  rebase(url: string) {
    return this.merge(url, 'rebase')
  }

  squash(url: string) {
    return this.merge(url, 'squash')
  }

  async close(url: string, commentUrl: string) {
    if (this.content) await this.reply(commentUrl)
    await this.request('PATCH', url, this.session.text('github.action-failed'), {
      state: 'closed',
    })
  }

  async shot(url: string, selector: string, padding: number[] = []) {
    const page = await this.session.app.puppeteer.page()
    let buffer: Buffer
    try {
      await page.goto(url)
      const el = await page.$(selector)
      const clip = await el.boundingBox()
      const [top = 0, right = 0, bottom = 0, left = 0] = padding
      clip.x -= left
      clip.y -= top
      clip.width += left + right
      clip.height += top + bottom
      buffer = await page.screenshot({ clip })
    } catch (error) {
      new Logger('puppeteer').warn(error)
      return this.session.text('github.screenshot-failed')
    } finally {
      await page.close()
    }
    return segment.image(buffer, 'image/png')
  }
}
