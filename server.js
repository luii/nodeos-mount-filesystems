#!/usr/bin/env node

"use strict"

// Dependencies
const fs         = require('fs')
const path       = require('path')
const proc       = require('child_process')
const async      = require('async')
const mkdirp     = require('mkdirp')
const prompt     = require('prompt')
const rimraf     = require('rimraf')
const utils      = require('nodeos-mount-utils')
const each       = async.each
const parallel   = async.parallel
const eachSeries = async.eachSeries

// Global variables
const MS_BIND    = utils.flags.MS_BIND
const MS_NODEV   = utils.flags.MS_NODEV
const MS_NOSUID  = utils.flags.MS_NOSUID
const flags      = MS_NODEV | MS_NOSUID
const EXCLFS_BIN = '/bin/exclfs'
const HOME       = '/tmp'

/**
 * cmdline is a file located inside `/proc/cmdline`
 * it contains information about the `initrd`, `root` partition and other stuff
 * @type {String}
 */
let cmdline

/**
 * This path points either to `/tmp`
 * @todo This can be removed because its only used once
 *       we could just use $HOME because both point to `/tmp`
 * @type {String}
 */
let ROOT_HOME = ''

/**
 * This variable holds the `single` key if its available in `/proc/cmdline`
 * @type {String}
 */
let single

/**
 * This callback is part of the `mountDevProcTmp_ExecInit` function
 * @callback mountDevProcCallback
 * @param    {Error} error The callback is called with a error if the devices
 *                         couldnt be mounted
 */

/**
 * This error handler traces the error and starts a node.js repl
 * @access private
 * @param  {Error} error The error that gets traced
 */
function onerror(error)
{
  if(error)
  {
    // Error mounting the root filesystem or executing init, enable REPL
    console.trace(error)
    utils.startRepl('NodeOS-mount-filesystems')
  }
}

/**
 * This functions takes the `cmdline` from `/proc/cmdline` **showed below in
 * the example** and splits it into key/value pairs
 * @access private
 * @param  {String} cmdline This string contains information about the
 *                          initrd and the root partition
 * @return {Object}         It returns a object containing key/value pairs
 *                          if there is no value for the key then its just true.
 *                          **For more Information, look at the example**
 * @example
 *   var cmdline1 = 'initrd=\\initramfs-linux.img root=PARTUUID=someuuidhere\n'
 *   var cmdline2 = 'somevar root=PARTUUID=someuuidhere\n'
 *
 * 	 var res1 = linuxCmdline(cmdline1)
 * 	 var res2 = linuxCmdline(cmdline2)
 * 	 console.log(res1)
 * 	 //-> { initrd: '\\initramfs-linux.img',root: 'PARTUUID=someuuidhere' }
 * 	 console.log(res2)
 * 	 //-> { somevar: true, root: 'PARTUUID=someuuidhere' }
 */
function linuxCmdline(cmdline)
{
  let result = {}

  cmdline.trim().split(' ').forEach(arg => {
    arg = arg.split('=')

    let key = arg.shift()
    let val = true

    if(arg.length)
    {
      val = arg.join('=').split(',')
      if(val.length === 1) val = val[0]
    }

    result[key] = val
  })

  return result
}

/**
 * This functions mounts the provided path to the device.
 * **If no device is available then it uses the type**
 * @access   private
 * @param    {Object}       info          This object holds information
 *                                        about the folder to create
 * @property {String}       info.dev      Device-File being mounted
 *                                        (located in `/dev`) a.k.a. devFile.
 * @property {String}       info.path     Directory to mount the device to.
 * @property {String}       info.type     Filesystem identificator
 *                                        (one of `/proc/filesystems`).
 * @property {Array|Number} info.[flags]  Flags for mounting
 * @property {String}       info.[extras] The data argument is
 *                                        interpreted by the different
 *                                        file systems. Typically it is a
 *                                        string of comma-separated options
 *                                        understood by this file system.
 * @param {Function}     callback         Function called after the
 *                                        mount operation finishes.
 *                                        Receives only one argument err.
 */
function mkdirMountInfo(info, callback)
{
  let dev = info.dev || info.type

  utils.mkdirMount(dev, info.path, info.type, info.flags, info.extras, callback)
}

/**
* Asynchronously create a target directory mount the source with `MS_MOVE` to it
* and move all files to the newly created directory
 * @access   private
 * @param    {Object}   info
 * @property {String}   info.source The source subtree to move
 * @property {String}   info.target The path to move the subtree into
 * @param    {Function} callback    The callback gets called if the move
 *                                  operations is done
 */
function mkdirMoveInfo(info, callback)
{
  utils.mkdirMove(info.source, info.target, callback)
}

/**
 * Mounts the user filesystems
 * @access private
 * @param  {Array} arr       A array containing objects with
 *                           the mounting information **For more Information
 *                           see mkdirMountInfo**
 * @param  {String} upperdir Path to the Init file
 *                           The path must contain a init file
 *                           Because execInit checks the gid & uid of the file
 *                           and of the "upperdir"
 * @example
 *   let infos = [ mountInfo1, mountInfo2 ] // see under mkdirMountInfo
 *                                          // for more Info
 *
 * 	 // Its necessary to exclude the init file from the path because
 * 	 // mountUserFilesystems does that for you
 *   mountUserFilesystems(infos, 'path/to/initfile', callback)
 */
function mountUserFilesystems(arr, upperdir, callback)
{
  each(arr, mkdirMountInfo, error => {
    if(error) return callback(error)

    if(single) return callback()

    // Execute init
    utils.execInit(upperdir, [], error => {
      if(error) console.warn(error)

      return callback()
    })
  })
}

/**
 * Waits until dev is mounted and then executes `mountUserFilesystems` to
 * mount `${upperdir}/proc` and `${upperdir}/tmp`
 * @access private
 * @param  {String}               upperdir The upperdir
 * @param  {Boolean}              isRoot   True if user is root, false if not
 * @param  {Function}             callback The callback function
 * @return {mountDevProcCallback}          Returns the callback function
 */
function mountDevProcTmp_ExecInit(upperdir, isRoot, callback)
{
  let arr =
  [
    {
      dev: '/proc',
      path: `${upperdir}/proc`,
      flags: MS_BIND
    },
    {
      path: `${upperdir}/tmp`,
      type: 'tmpfs',
      flags: flags
    }
  ]

  let path = `${upperdir}/dev`,

  // Root user
  if(isRoot && fs.existsSync(EXCLFS_BIN))
    return mkdirp(path, '0000', error => {
      if(error && error.code !== 'EEXIST') return callback(error)

      let argv = [ '/dev', path, '-o', 'ownerPerm=true' ]
      let options =
      {
        detached: true,
        stdio: 'inherit'
      }

      spawn(EXCLFS_BIN, argv, options)
      .on('error', console.error.bind(console))
      .unref()

      waitUntilDevMounted(path, 5, error => {
        if(error) return callback(error)

        // Remove ExclFS from initramfs to free memory
        rimraf(EXCLFS_BIN)
        rimraf('/lib/node_modules/exclfs')

        return mountUserFilesystems(arr, upperdir, callback)
      })
    })

  // Regular user
  arr.unshift({
    dev: `${ROOT_HOME}/dev`,
    path: path,
    flags: MS_BIND
  })

  return mountUserFilesystems(arr, upperdir, callback)
}

/**
 * `overlay_user` first creates the workdir (with `0100` permission)
 * which is a string out of the folder where all users are located, a
 * constant `.workdirs` and the username e.g. `${usersFolder}/.workdirs/${user}`
 * @access private
 * @param  {String}   usersFolder The folder where all user folders are
 * @param  {String}   user        The name of the user
 * @param  {Function} callback    The callback function
 */
function overlay_user(usersFolder, user, callback)
{
  let upperdir = `${usersFolder}/${user}`
  let workdir  = `${usersFolder}/.workdirs/${user}`

  mkdirp(workdir, '0100', error => {
    if(error && error.code !== 'EEXIST') return callback(error)

    // Craft overlayed filesystem
    let type   = 'overlay'
    let extras =
    {
      lowerdir: '/',
      upperdir: upperdir,
      workdir : workdir
    }

    if(user === 'root') upperdir = '/root'

    utils.mkdirMount(type, upperdir, type, MS_NOSUID, extras, error => {
      if(error) return callback(error)

      if(user !== 'root')
        return mountDevProcTmp_ExecInit(upperdir, false, callback)

      // Allow root to access to the content of the users filesystem
      eachSeries(
      [
        {
          source: HOME,
          target: `${upperdir}/home`
        },
        {
          source: upperdir,
          target: HOME
        }
      ],
      mkdirMoveInfo, err => {
        if(err) return callback(err)

        mountDevProcTmp_ExecInit(HOME, true, e => {
          if(e) return callback(e)

          ROOT_HOME = HOME

          return callback(null, `${HOME}/home`)
        })
      })
    })
  })
}

/**
 * Filter folders that are valid user `$HOME`
 * @access private
 * @param  {String}  user The name of the user
 * @return {Boolean}      Returns true If the first char is not a dot
 *                        and not `root` and not ´lost+found´
 */
function filterUser(user)
{
  return user[0] !== '.' && user !== 'root' && user !== 'lost+found'
}

/**
 * Mount users directories and exec their `init` files
 * @access private
 * @param  {String}   usersFolder The path to all user directories
 * @param  {Function} callback    The callback function
 * @return {Function}             Returns the callback either with a error
 *                                or with null if everything was fine
 */
function overlay_users(usersFolder, callback)
{
  function done(error)
  {
    // Remove the modules from initramfs to free memory
    // rimraf('/lib/node_modules')
    rimraf('/lib/node_modules/nodeos-mount-utils')

    // Make '/usr' a opaque folder (OverlayFS feature)
    rimraf('/usr')

    return callback(error)
  }

  // Mount users directories and exec their init files
  fs.readdir(usersFolder, (err, users) => {
    if(err) return done(err)

    each(users.filter(filterUser),
         overlay_user.bind(undefined, usersFolder),
         done)
  })
}

/**
 * This helper waits with a limit of tries until the path exists
 * @access private
 * @param  {String}   path     The path to check for
 * @param  {Number}   tries    A limit of tries
 * @param  {Function} callback The callback function
 * @return {Function}          Returns the callback with either nothing
 *                             or with a error
 */
function waitUntilExists(path, tries, callback)
{
  fs.exists(path, exists => {
    if(exists) return callback()

    if(tries-- <= 0) return callback(new Error(`${path} not exists`))

    setTimeout(waitUntilExists, 1000, path, tries, callback)
  })
}

/**
 * This helper waits with a limit of tries until the device is mounted
 * @access private
 * @param  {String}   path     The path to read the files from
 * @param  {Number}   tries    A limit of tries
 * @param  {Function} callback The callback function
 * @return {Function}          Returns the callback with either a error
 *                             or nothing (if the amount of files is bigger 1)
 */
function waitUntilDevMounted(path, tries, callback)
{
  fs.readdir(path, (error, files) => {
    if(error) return callback(error)

    if(files.length > 1) return callback()

    if(tries-- <= 0) return callback(new Error(`${path} not mounted`))

    setTimeout(waitUntilDevMounted, 1000, path, tries, callback)
  })
}

/**
 * A callback function for the askLocation function
 * @access private
 * @param  {Error}    error  If the error is null it not gets printed
 * @param  {Object}   result A object containing a key for the path to the userfs
 * @return {Function}        Returns either a prompt or a error if the mount
 *                           process fails
 */
function pathToUserfs(error, result)
{
  if(error) console.warn(error)

  cmdline.root = result['path to userfs']
  return mountUsersFS(cmdline)
}

/**
 * Starts a prompt and asks for the location of the userfs
 * @access private
 * @param  {Error} error The error will be printed in the console
 */
function askLocation(error)
{
  console.warn('Could not find userfs:', error)

  prompt.start()
  prompt.get('path to userfs', pathToUserfs)
}

/**
 * If the `single` key is set in the cmdline it starts a admin repl
 * If not it just overlays the users filesystem
 * @access private
 * @param  {String} home The path to folder of the users
 */
function adminOrUsers(home)
{
  // Enter administrator mode
  if(single) return utils.startRepl('Administrator mode')

  // Users filesystem don't have a root user, just overlay users folders
  return overlay_users(home, onerror)
}

/**
 * Prepares the session and checks if the users filesystem has a root account,
 * if not check if `/proc/cmdline` has the single key
 * It deletes the `root`, `rootfstype` and `vga` environment variables
 * and adds `NODE_PATH` to it.
 * @access private
 * @return {Repl} Returns either a repl or a error if the error contains
 *                a `ENOENT` code
 */
function prepareSessions()
{
  // Update environment variables
  var env = process.env

  delete env['root']
  delete env['rootfstype']
  delete env['vga']

  env['NODE_PATH'] = '/lib/node_modules'

  // Check if users filesystem has an administrator account
  fs.readdir(`${HOME}/root`, error => {
    if(error)
    {
      if(error.code != 'ENOENT') return onerror(error)

      return adminOrUsers(HOME)
    }

    overlay_user(HOME, 'root', (error, home) => {
      if(error) return onerror(error)

      return adminOrUsers(home)
    })
  })
}

/**
 * This function mounts the userfs
 * if the root env variable contains `container` it prepares the session
 * and if there is no root env var then it awaits the user device and
 * then mounts the user device and then prepares the session
 * @access private
 * @param  {Object}       cmdline This objects holds key/value pairs from the
 *                                `/proc/cmdline` file
 * @return {Prompt|Error}         It returns either a prompt if the
 *                                tries has reached its limit or a error
 *                                if the `mkdirMount` fails to create the user
 *                                device
 */
function mountUsersFS(cmdline)
{
  var usersDev = process.env.root
  if(usersDev === undefined) usersDev = cmdline.root

  // Running on a container (Docker, vagga), don't mount the users filesystem
  if(usersDev === 'container') return prepareSessions()

  // Running on real hardware or virtual machine, mount the users filesystem
  else if(usersDev)
    waitUntilExists(usersDev, 5, error => {
      if(error) return askLocation(error)

      // Mount users filesystem
      var type   = process.env.rootfstype || cmdline.rootfstype || 'auto'
      var extras = { errors: 'remount-ro' }

      utils.mkdirMount(resolve(usersDev), HOME, type, flags, extras, err => {
        if(err) return onerror(err)

        return prepareSessions()
      })
    })

  // Users filesystem is not defined, launch a Node.js REPL
  else
  {
    console.warn('*************************************************************')
    console.warn('* Users filesytem is not defined, will use a tmpfs instead. *')
    console.warn('*                                                           *')
    console.warn('* ALL YOUR CHANGES WILL BE LOST IF NOT SAVED IN OTHER PLACE *')
    console.warn('*                                                           *')
    console.warn('* You can find info about how to use an users filesystem at *')
    console.warn('*                                                           *')
    console.warn('*             https://github.com/NodeOS/NodeOS              *')
    console.warn('*************************************************************')

    utils.startRepl('NodeOS-mount-filesystems')
  }
}


// Change umask system wide so new files are accesible ONLY by its owner
process.umask(0066)

// Remove from initramfs the files only needed on boot to free memory
rimraf('/bin/nodeos-mount-filesystems')
rimraf('/init')
rimraf('/lib/node_modules/nodeos-mount-filesystems')
rimraf('/sbin')

// Symlinks for config data optained from `procfs`
mkdirp('/etc', '0100', function(error)
{
  if(error && error.code != 'EEXIST') return callback(error)
  cmdline = linuxCmdline(fs.readFileSync('/proc/cmdline', 'utf8'))

  try {
    fs.symlinkSync('/proc/mounts', '/etc/mtab')
  } catch (e) {
    if (e && e.code !== 'EEXIST') return callback(e)
  }

  try {
    fs.symlinkSync('/proc/net/pnp', '/etc/resolv.conf')
  } catch (e) {
    if (e && e.code !== 'EEXIST') return callback(e)
  }

  single = cmdline.single

  // Mount root filesystem
  mountUsersFS(cmdline)
})
